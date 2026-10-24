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
from datetime import datetime, timedelta, timezone
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

    def test_shanghai_cache_day_boundary(self):
        from radar import github_radar
        from radar.timezones import REPORT_TIMEZONE

        now = datetime(2026, 10, 18, 16, 1, tzinfo=timezone.utc)
        self.assertEqual(now.astimezone(REPORT_TIMEZONE).utcoffset(), timedelta(hours=8))
        self.assertEqual(now.astimezone(REPORT_TIMEZONE).date().isoformat(), "2026-10-19")

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return now.astimezone(tz)

        with patch.object(github_radar, "datetime", FixedDateTime):
            self.assertFalse(github_radar._same_shanghai_day({"fetched_at": "2026-10-18T15:59:00+00:00"}))
            self.assertTrue(github_radar._same_shanghai_day({"fetched_at": "2026-10-18T16:00:00+00:00"}))

    def test_cli_is_json_and_has_no_publish_route(self):
        result = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "query"], input='{"date":"../../secret"}',
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["status"], "failed")
        help_result = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "--help"], capture_output=True, text=True, encoding="utf-8")
        self.assertNotIn("send", help_result.stdout)
        self.assertNotIn("publish", help_result.stdout)


def candidate(index, **changes):
    record = {
        "id": f"c{index}", "event_id": f"e{index}", "source": f"Source {index}",
        "source_type": "official_news", "rank_score": 80.0 - index * 0.1,
        "alert_level": "watch", "verification_status": "single_source",
        "recency_status": "current", "source_text_status": "available",
        "recommended_highlight": False,
    }
    record.update(changes)
    return record


class DigestSelectionTest(unittest.TestCase):
    def pick(self, records, limit=40):
        from radar.newsroom import select_digest_records
        return select_digest_records(records, limit)

    def test_keeps_rank_order_and_reports_what_was_dropped(self):
        records = [candidate(i) for i in range(6)] + [
            candidate(10, recency_status="recovered"),
            candidate(11, verification_status="low_evidence"),
            candidate(12, source_text_status="unavailable"),
            candidate(13, rank_score=50.0),
            candidate(14, event_id="e0"),
        ]
        chosen, info = self.pick(records, 40)
        self.assertEqual([r["id"] for r in chosen], [f"c{i}" for i in range(6)])
        self.assertEqual(info["collected"], 11)
        self.assertEqual(info["selected"], 6)
        self.assertEqual(info["dropped"], {"below_score": 1, "duplicate_event": 1, "low_evidence": 1,
                                           "stale": 1, "unavailable": 1})

    def test_urgent_items_survive_staleness_and_score_floor(self):
        urgent = candidate(1, recency_status="recovered", alert_level="high", verification_status="first_party",
                           rank_score=55.0)
        unreadable = candidate(2, source_text_status="unavailable", alert_level="high",
                               verification_status="first_party")
        weak = candidate(3, source_text_status="unavailable", alert_level="high")
        chosen, _ = self.pick([urgent, unreadable, weak, candidate(4), candidate(5), candidate(6)], 40)
        ids = [r["id"] for r in chosen]
        self.assertIn("c1", ids)
        self.assertIn("c2", ids)
        self.assertNotIn("c3", ids, "只有一方来源的不可读记录不能靠告警等级入选")

    def test_caps_per_source_and_per_type(self):
        same_source = [candidate(i, source="One Feed") for i in range(6)]
        chosen, info = self.pick(same_source, 40)
        self.assertEqual(len(chosen), 3)
        self.assertEqual(info["dropped"], {"source_cap": 3})
        same_type = [candidate(i, source_type="youtube") for i in range(30)]
        chosen, info = self.pick(same_type, 10)
        self.assertEqual(len(chosen), 4, "单一来源类型最多占 40%")
        self.assertEqual(info["dropped"], {"type_cap": 26})

    def test_recommended_highlight_bypasses_caps_but_not_duplicate_events(self):
        records = [candidate(i, source="One Feed", rank_score=50.0, recommended_highlight=True) for i in range(5)]
        records.append(candidate(9, event_id="e0", recommended_highlight=True))
        chosen, info = self.pick(records, 40)
        self.assertEqual(len(chosen), 5)
        self.assertEqual(info["dropped"], {"duplicate_event": 1})

    def test_limit_is_enforced_and_validated(self):
        records = [candidate(i, source_type=f"type{i % 7}", source=f"S{i}") for i in range(30)]
        chosen, info = self.pick(records, 8)
        self.assertEqual(len(chosen), 8)
        self.assertEqual(info["dropped"]["over_limit"], 22)
        for bad in (4, 101):
            with self.assertRaisesRegex(ValueError, "limit"):
                self.pick(records, bad)

    def test_environment_limit(self):
        from radar.workflow import digest_limit
        with patch.dict(os.environ, {"AI_NEWS_DIGEST_LIMIT": "25"}):
            self.assertEqual(digest_limit(), 25)
        with patch.dict(os.environ, {"AI_NEWS_DIGEST_LIMIT": "many"}):
            with self.assertRaisesRegex(ValueError, "AI_NEWS_DIGEST_LIMIT"):
                digest_limit()
        with patch.dict(os.environ, {"AI_NEWS_DIGEST_LIMIT": ""}):
            self.assertEqual(digest_limit(), 40)


class CuratedPrepareTest(unittest.TestCase):
    """prepare() 端到端：采集全量进 SQLite，冻结快照只含精选。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="raptor-news-prep-")
        self.addCleanup(self.temporary.cleanup)
        environment = patch.dict(os.environ, {"AI_NEWS_STATE_DIR": self.temporary.name})
        environment.start()
        self.addCleanup(environment.stop)

    def collected(self, count):
        now = datetime.now(timezone.utc)
        return [ContentItem(
            item_id=f"id-{i}", source_type="official_news", source=f"官方发布 · Vendor {i % 12}",
            title=f"Vendor {i % 12} ships model {i} with agent API {i}", published_at=now - timedelta(hours=i % 20),
            url=f"https://vendor{i % 12}.example.com/news/{i}",
            raw_source_text="The vendor released a model and an API for agent workflows today. " * 3,
        ) for i in range(count)]

    def run_prepare(self, items):
        from radar import workflow
        from radar.models import SourceHealth
        health = [SourceHealth("official_news", "ok", 10, 0, 0)]
        with patch.object(workflow, "collect_sources", return_value=(items, health)):
            return workflow.prepare(news.report_date())

    def test_snapshot_is_curated_but_history_and_counts_are_complete(self):
        code, result = self.run_prepare(self.collected(80))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["collected"], 80)
        self.assertLessEqual(result["total"], 40)
        self.assertEqual(result["selection"]["collected"], 80)
        self.assertEqual(result["selection"]["selected"], result["total"])
        payload = json.loads(Path(result["source_file"]).read_text(encoding="utf-8"))
        self.assertEqual(len(payload["items"]), result["total"])
        self.assertTrue(all(r["recency_status"] in {"current", "recovered"} for r in payload["items"]))
        self.assertEqual(payload["selection"], result["selection"])
        from radar.intelligence import verify_source_payload
        verify_source_payload(payload)
        db = Storage(Path(self.temporary.name))
        db.initialize()
        self.assertEqual(len(db.items_for_digest(news.report_date())), 80, "历史与趋势仍保留全量采集")

    def test_prepare_reader_exposes_selection_and_digest_header_states_it(self):
        code, result = self.run_prepare(self.collected(60))
        self.assertEqual(code, 0, result)
        with patch.object(news, "prepare", side_effect=AssertionError("不得重新采集")):
            page = news.prepare_news({"limit": 20})
        self.assertTrue(page["cached"])
        self.assertEqual(page["selection"], result["selection"])
        self.assertEqual(page["total"], result["total"])
        self.assertLess(page["total"], 60)
        header = news.markdown_for("2026-10-24", [], {}, result["selection"])
        self.assertIn(f"从 {result['collected']} 条采集记录中精选 {result['selection']['selected']} 条", header)
        self.assertNotIn("精选", news.markdown_for("2026-10-24", [], {}, None))

    def test_cache_pruning_removes_only_stale_responses(self):
        db = Storage(Path(self.temporary.name))
        db.initialize()
        db.put_http_cache("https://fresh.example.com/feed", b"fresh")
        db.put_http_cache("https://old.example.com/feed", b"old")
        with db._connect() as connection:
            connection.execute("UPDATE http_cache SET fetched_at = ? WHERE url = ?",
                               ((datetime.now(timezone.utc) - timedelta(days=9)).isoformat(),
                                "https://old.example.com/feed"))
        self.assertEqual(db.prune_http_cache(), 1)
        self.assertIsNotNone(db.get_http_cache("https://fresh.example.com/feed"))
        self.assertIsNone(db.get_http_cache("https://old.example.com/feed"))


class CommandLineTest(unittest.TestCase):
    def test_flags_utf8_request_file_and_standalone_state_dir(self):
        with tempfile.TemporaryDirectory(prefix="raptor-news-cli-") as directory:
            request = Path(directory) / "request.json"
            request.write_text('{"date": "../../x"}', encoding="utf-8-sig")
            env = {**os.environ, "AI_NEWS_STATE_DIR": directory, "PYTHONUTF8": "1"}
            run = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "query", "--request-file", str(request)],
                                 capture_output=True, env=env, stdin=subprocess.DEVNULL)
            self.assertEqual(run.returncode, 1)
            self.assertEqual(json.loads(run.stdout.decode("utf-8"))["status"], "failed")
            flagged = subprocess.run([sys.executable, "-B", str(ENGINE / "news.py"), "query", "--date", "2020-01-01"],
                                     capture_output=True, env=env, stdin=subprocess.DEVNULL)
            self.assertIn("冻结来源", json.loads(flagged.stdout.decode("utf-8"))["error"])

    def test_standalone_marker_moves_state_next_to_the_skill(self):
        from radar import workflow
        marker = workflow.skill_root() / "STANDALONE"
        self.assertFalse(marker.exists(), "仓库源码里不应带独立包标记")
        with patch.dict(os.environ, {"AI_NEWS_STATE_DIR": ""}), \
                patch.object(Path, "is_file", lambda self: self.name == "STANDALONE"):
            self.assertEqual(workflow.state_dir(), workflow.skill_root().parent / "data")


if __name__ == "__main__":
    unittest.main(verbosity=2)
