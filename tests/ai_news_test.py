"""本地新闻端到端回归：冻结来源、分页草稿、校验、并发锁及查询。"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1] / "scripts" / "ai-news"
sys.path.insert(0, str(ENGINE))
spec = importlib.util.spec_from_file_location("local_news", ENGINE / "news.py")
news = importlib.util.module_from_spec(spec)
spec.loader.exec_module(news)
from radar.models import ContentItem
from radar.storage import Storage, atomic_write_json


class NewsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="raptor-news-test-")
        self.addCleanup(self.temporary.cleanup)
        self.environment = patch.dict(os.environ, {"AI_NEWS_STATE_DIR": self.temporary.name})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.date = "2026-08-25"
        self.payload = self.freeze(3)
        self.token = news.source_hash(self.payload)

    def freeze(self, count, *, status="available", same_event=False, recovered=False):
        records = []
        for index in range(count):
            record = {
                "id": f"item-{index}", "source_type": "official_news", "source": "Vendor",
                "title": f"Update {index}", "url": f"https://example.com/news/{index}",
                "published_at": f"{self.date}T02:00:00+00:00", "source_text_status": status,
                "source_text": "Vendor released an AI API with structured output.",
                "unavailable_reason": "source unavailable" if status == "unavailable" else "",
                "rank_position": index + 1, "rank_score": 90, "recommended_highlight": True,
                "event_id": "one-event" if same_event else f"event-{index}",
                "recency_status": "recovered" if recovered else "current",
            }
            record["source_text_sha256"] = hashlib.sha256(record["source_text"].encode()).hexdigest()
            record["record_sha256"] = hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            records.append(record)
        token = hashlib.sha256(json.dumps(records, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        payload = {"schema_version": 2, "date": self.date, "items": records,
                   "generated_at": f"{self.date}T05:00:00+00:00",
                   "provenance": {"source_set_sha256": token}}
        atomic_write_json(news.artifact_paths(self.date)["source"], payload)
        return payload

    def entry(self, index, **changes):
        return {"url": f"https://example.com/news/{index}", "summary": "Vendor 表示其 AI API 新增结构化输出。",
                "highlight": False, **changes}

    def save(self, entries, finalize=False):
        return news.save_digest({"date": self.date, "source_set_sha256": news.source_hash(self.payload),
                                 "entries": entries, "finalize": finalize})

    def test_pages_resume_finalize_and_read(self):
        with patch.object(news, "prepare", side_effect=AssertionError("不得重新采集")):
            page = news.prepare_news({"date": self.date, "limit": 2})
            self.assertTrue(page["cached"])
            self.assertEqual(page["next_offset"], 2)
            self.assertEqual(page["source_set_sha256"], self.token)
            self.assertEqual(self.save([self.entry(0), self.entry(1)])["remaining"], 1)
            rest = news.prepare_news({"date": self.date, "offset": 2})
            self.assertEqual(rest["saved"], 2)
            self.assertEqual(len(rest["saved_urls"]), 0)
            self.assertEqual(len(rest["items"]), 1)
            self.save([self.entry(2)])
            self.save([self.entry(0, highlight=True)])
            self.assertEqual(self.save([], True)["status"], "saved")
            result = news.query_news({"date": self.date, "limit": 1})
            self.assertEqual(result["total"], 3)
            self.assertEqual(len(result["highlights"]), 1)
            self.assertEqual(self.save([self.entry(0, summary="overwrite")], True)["status"], "frozen")
            self.assertIn("结构化输出", Path(result["digest_file"]).read_text(encoding="utf-8"))

    def test_refuses_partial_finalize(self):
        with self.assertRaisesRegex(ValueError, "尚缺"):
            self.save([self.entry(0)], True)
        self.assertFalse(news.artifact_paths(self.date)["digest"].exists())

    def test_source_fingerprint_and_tampering(self):
        with self.assertRaisesRegex(ValueError, "快照"):
            news.save_digest({"date": self.date, "source_set_sha256": "0" * 64, "entries": []})
        self.payload["items"][0]["source_text"] = "tampered"
        atomic_write_json(news.artifact_paths(self.date)["source"], self.payload)
        with self.assertRaisesRegex(ValueError, "provenance"):
            news.prepare_news({"date": self.date})

    def test_rejects_unknown_links_and_invented_numbers(self):
        with self.assertRaisesRegex(ValueError, "冻结来源"):
            self.save([self.entry(0, url="https://example.com/invented")])
        with self.assertRaises(ValueError):
            self.save([self.entry(0, summary="Vendor 发布了 99999 个新模型。")])
        with self.assertRaisesRegex(ValueError, "单行"):
            self.save([self.entry(0, summary="摘要\n### 1. [injected](https://evil.invalid)")])

    def test_global_highlight_limit_and_event_uniqueness(self):
        self.payload = self.freeze(7)
        with self.assertRaisesRegex(ValueError, "exceed"):
            self.save([self.entry(i, highlight=True) for i in range(7)])
        self.payload = self.freeze(2, same_event=True)
        with self.assertRaisesRegex(ValueError, "per event"):
            self.save([self.entry(0, highlight=True), self.entry(1, highlight=True)])

    def test_quality_gate_rejects_disallowed_highlight(self):
        self.payload["items"][0]["recommended_highlight"] = False
        record = self.payload["items"][0]
        del record["record_sha256"]
        record["record_sha256"] = hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        self.payload["provenance"]["source_set_sha256"] = hashlib.sha256(json.dumps(self.payload["items"], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        atomic_write_json(news.artifact_paths(self.date)["source"], self.payload)
        with self.assertRaisesRegex(ValueError, "quality gate"):
            self.save([self.entry(0, highlight=True)])

    def test_unavailable_and_recovered_records(self):
        self.payload = self.freeze(1, status="unavailable")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.save([self.entry(0)])
        self.assertEqual(self.save([self.entry(0, summary="不可用（source unavailable）")], True)["status"], "saved")

    def test_recovered_requires_original_date(self):
        self.payload = self.freeze(1, recovered=True)
        with self.assertRaisesRegex(ValueError, "补录"):
            self.save([self.entry(0)])
        entry = self.entry(0, summary=f"补录（{self.date}）：Vendor 表示其 AI API 新增结构化输出。")
        self.assertEqual(self.save([entry], True)["status"], "saved")

    def test_no_backdated_collection(self):
        with patch.object(news, "prepare", side_effect=AssertionError("不得采集历史日期")):
            with self.assertRaisesRegex(ValueError, "历史日期"):
                news.prepare_news({"date": "2026-08-24"})
        for value in ("../../secret", "2026-8-2", "2026-02-30", "9999-12-31"):
            with self.assertRaises(ValueError):
                news.report_date(value)

    def test_failed_collection_is_not_a_digest(self):
        with patch.object(news, "report_date", return_value="2026-08-26"), patch.object(news, "doctor", return_value={"status": "ok"}), patch.object(news, "prepare", return_value=(1, {"status": "failed", "stage": "quality_gate"})):
            result = news.prepare_news({})
        self.assertEqual(result["stage"], "quality_gate")
        self.assertFalse(news.artifact_paths("2026-08-26")["digest"].exists())

    def test_breaking_contains_evidence_and_trend_uses_local_history(self):
        brief = news.query_news({"date": self.date, "kind": "breaking"})
        self.assertEqual(brief["status"], "ready")
        self.assertIn("source_text", brief["report"]["items"][0])
        self.assertEqual(news.query_news({"date": self.date, "kind": "trend"})["status"], "empty")
        storage = Storage(Path(self.temporary.name))
        storage.initialize()
        item = ContentItem(item_id="a", source_type="official_news", source="Vendor", title="AI API update",
                           published_at=datetime(2026, 8, 25, 2, tzinfo=timezone.utc), url="https://example.com/a",
                           raw_source_text="Vendor released an AI API with structured output.")
        storage.add_new_items_to_digest(self.date, [item])
        trend = news.query_news({"date": self.date, "kind": "trend", "days": 7})
        self.assertEqual(trend["report"]["total"], 1)

    def test_lock_conflict_and_release(self):
        file = Path(self.temporary.name) / "locks" / "test.lock"
        with news.daily_lock(file):
            with self.assertRaisesRegex(RuntimeError, "active"):
                with news.daily_lock(file):
                    self.fail("锁不能重入")
        with news.daily_lock(file):
            pass

    def test_cli_is_json_and_has_no_publish_route(self):
        result = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "query"], input='{"date":"../../secret"}',
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["status"], "failed")
        help_result = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "--help"], capture_output=True, text=True, encoding="utf-8")
        self.assertNotIn("send", help_result.stdout)
        self.assertNotIn("publish", help_result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
