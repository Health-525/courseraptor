"""CourseRaptor 本地新闻入口：仅采集、查询和保存校验后的日报。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from radar.digest import validate_frozen_digest
from radar.intelligence import verify_source_payload
from radar.storage import atomic_write_json, atomic_write_text
from radar.timezones import REPORT_TIMEZONE
from radar.workflow import (
    artifact_paths,
    builders_x_accounts_file,
    channels_file,
    daily_lock,
    github_radar_file,
    huggingface_radar_file,
    industry_digest_sources_file,
    official_news_sources_file,
    prepare,
    render_breaking_report,
    render_trend_report,
    security_advisories_file,
    state_dir,
)


def report_date(value: object = None) -> str:
    today = datetime.now(REPORT_TIMEZONE).strftime("%Y-%m-%d")
    if value is None:
        return today
    if not isinstance(value, str):
        raise ValueError("date 必须是 YYYY-MM-DD")
    parsed = datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    if parsed != value or parsed > today:
        raise ValueError("date 必须是有效的 YYYY-MM-DD，且不能晚于今天")
    return parsed


def integer(value: object, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"分页或数量参数必须是 {minimum}–{maximum} 范围内的整数")
    return value


def source_payload(date: str) -> dict:
    file = artifact_paths(date)["source"]
    if not file.is_file():
        raise ValueError("当天没有冻结来源；今天请先调用 prepare_ai_news，历史日期仅可查询已有记录")
    payload = json.loads(file.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 2 or payload.get("date") != date:
        raise ValueError("来源版本或日期不匹配")
    verify_source_payload(payload)
    return payload


def source_hash(payload: dict) -> str:
    return str(payload["provenance"]["source_set_sha256"])


def paginate(items: list, request: dict) -> dict:
    offset = integer(request.get("offset"), 0, 0, 100_000)
    limit = integer(request.get("limit"), 8, 1, 20)
    page = []
    size = 0
    for item in items[offset:offset + limit]:
        encoded_size = len(json.dumps(item, ensure_ascii=False))
        if page and size + encoded_size > 32_000:
            break
        page.append(item)
        size += encoded_size
    end = offset + len(page)
    return {"total": len(items), "offset": offset, "items": page,
            "next_offset": end if end < len(items) else None}


def doctor() -> dict:
    from radar.sources import load_builders_x_accounts, load_channels
    from radar.official_news import load_official_sources
    from radar.github_radar import load_github_radar_config
    from radar.security_advisories import load_security_advisory_config
    from radar.huggingface_radar import load_huggingface_radar_config

    checks = [{"name": "python", "status": "ok" if sys.version_info >= (3, 11) else "error",
               "detail": f"Python {sys.version_info.major}.{sys.version_info.minor}"}]
    for name, loader, file in [
        ("official", load_official_sources, official_news_sources_file()),
        ("editorial", load_official_sources, industry_digest_sources_file()),
        ("youtube", load_channels, channels_file()),
        ("builders-x", load_builders_x_accounts, builders_x_accounts_file()),
        ("github", load_github_radar_config, github_radar_file()),
        ("security", load_security_advisory_config, security_advisories_file()),
        ("models", load_huggingface_radar_config, huggingface_radar_file()),
    ]:
        try:
            loader(file)
            checks.append({"name": name, "status": "ok"})
        except (OSError, ValueError) as error:
            checks.append({"name": name, "status": "error", "detail": str(error)})
    parent = state_dir()
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    checks.append({"name": "state", "status": "ok" if os.access(parent, os.W_OK) else "error"})
    return {"status": "error" if any(c["status"] == "error" for c in checks) else "ok",
            "checks": checks}


SOURCE_FIELDS = (
    "id", "url", "title", "source", "source_type", "source_text", "source_text_status",
    "unavailable_reason", "published_at", "recency_status", "rank_position", "rank_score",
    "rank_reason", "recommended_highlight", "event_id", "story_role", "verification_status",
    "alert_level", "entities", "topics",
)


def reader_record(item: dict) -> dict:
    record = {key: item.get(key) for key in SOURCE_FIELDS}
    text = str(record.get("source_text") or "")
    # 某些变更日志很长；只把明确标记的证据摘录送入模型，原文仍保留在冻结快照。
    record["source_text"] = text[:8000]
    record["source_text_truncated"] = len(text) > 8000
    return record


def prepare_news(request: dict) -> dict:
    date = report_date(request.get("date"))
    with daily_lock(state_dir() / "locks" / "snapshot.lock"):
        cached = artifact_paths(date)["source"].is_file()
        if not cached:
            if date != report_date():
                raise ValueError("历史日期没有冻结来源，不能把今天采集的新闻写成历史新闻")
            diagnostics = doctor()
            if diagnostics["status"] != "ok":
                return diagnostics
            code, result = prepare(date)
            if code:
                return result
        payload = source_payload(date)
    records = [reader_record(item) for item in payload["items"]]
    draft_file = state_dir() / "reports" / f"{date}_draft.json"
    draft = json.loads(draft_file.read_text(encoding="utf-8")) if draft_file.is_file() else {}
    saved = draft.get("entries", {}) if draft.get("source_set_sha256") == source_hash(payload) else {}
    page = paginate(records, request)
    health = [{key: family.get(key) for key in ("source", "status", "fetched", "failed", "detail")}
              for family in payload.get("source_health", [])]
    return {"status": "prepared" if records else "empty", "date": date, "cached": cached,
            "generated_at": payload.get("generated_at"), "source_set_sha256": source_hash(payload),
            "quality_gate": payload.get("quality_gate"), "source_health": health,
            "digest_exists": artifact_paths(date)["digest"].is_file(),
            "saved": len(saved), "saved_urls": [item["url"] for item in page["items"] if item["url"] in saved],
            **page}


def markdown_for(date: str, records: list, entries: dict) -> str:
    lines = [f"# AI 前哨｜{date}", "", "摘要仅依据各条来源文本；发布方主张保留来源归属。", ""]
    for index, record in enumerate(records, 1):
        entry = entries[record["url"]]
        # 不允许来源或模型输出通过换行伪造下一条记录。
        values = [str(record["title"]), str(record["url"]), str(record["source"]), entry["summary"]]
        if any("\n" in value or "\r" in value for value in values):
            raise ValueError("标题、来源、链接和摘要必须是单行文本")
        title, url, source, summary = values
        lines.extend([f"### {index}. [{title}]({url})", f"- 来源：{source}",
                      f"- 重点：{'是' if entry['highlight'] else '否'}", f"- 来源摘要：{summary}", ""])
    return "\n".join(lines)


def save_digest(request: dict) -> dict:
    date = report_date(request.get("date"))
    with daily_lock(state_dir() / "locks" / "snapshot.lock"):
        payload = source_payload(date)
        token = source_hash(payload)
        if request.get("source_set_sha256") != token:
            raise ValueError("来源快照已变化，请重新读取 prepare_ai_news 返回的 source_set_sha256")
        paths = artifact_paths(date)
        if paths["digest"].is_file():
            return {"status": "frozen", "date": date, "message": "日报已冻结，请用 query_ai_news 读取"}
        records = payload["items"]
        if not records:
            return {"status": "empty", "date": date, "message": "当天无记录，不生成空壳日报"}
        by_url = {item["url"]: item for item in records}
        draft_file = paths["digest"].with_name(f"{date}_draft.json")
        draft = json.loads(draft_file.read_text(encoding="utf-8")) if draft_file.is_file() else {}
        entries = dict(draft.get("entries", {})) if draft.get("source_set_sha256") == token else {}
        updates = request.get("entries", [])
        if not isinstance(updates, list) or len(updates) > 20:
            raise ValueError("entries 必须是最多 20 条的数组")
        seen = set()
        for entry in updates:
            if not isinstance(entry, dict) or entry.get("url") not in by_url:
                raise ValueError("摘要链接不属于冻结来源")
            url = entry["url"]
            if url in seen:
                raise ValueError("同批不能重复提交一个链接")
            seen.add(url)
            summary = entry.get("summary")
            highlight = entry.get("highlight", False)
            if not isinstance(summary, str) or not summary.strip() or len(summary) > 2500:
                raise ValueError("summary 必须是 1–2500 字的来源摘要")
            if type(highlight) is not bool:
                raise ValueError("highlight 必须是布尔值")
            record = by_url[url]
            if record.get("recency_status") == "recovered" and record.get("source_text_status") == "available":
                prefix = f"补录（{str(record['published_at'])[:10]}）："
                if not summary.startswith(prefix):
                    raise ValueError("补录摘要必须使用其发布日期前缀：" + prefix)
            entries[url] = {"url": url, "summary": summary.strip(), "highlight": highlight}
        selected = [record for record in records if record["url"] in entries]
        if selected:
            validate_frozen_digest({"items": selected}, markdown_for(date, selected, entries))
        finalize = request.get("finalize", False)
        if type(finalize) is not bool:
            raise ValueError("finalize 必须是布尔值")
        missing = [record["url"] for record in records if record["url"] not in entries]
        if finalize and missing:
            raise ValueError(f"日报尚缺 {len(missing)} 条摘要，请继续分页处理")
        atomic_write_json(draft_file, {"source_set_sha256": token, "entries": entries})
        if not finalize:
            return {"status": "draft", "date": date, "saved": len(entries), "total": len(records),
                    "remaining": len(missing), "highlighted": sum(e["highlight"] for e in entries.values())}
        markdown = markdown_for(date, records, entries)
        validate_frozen_digest(payload, markdown)
        atomic_write_text(paths["digest"], markdown)
        return {"status": "saved", "date": date, "total": len(records), "digest_file": str(paths["digest"]),
                "highlights": [e for e in entries.values() if e["highlight"]]}


def query_news(request: dict) -> dict:
    date = report_date(request.get("date"))
    kind = request.get("kind", "daily")
    if kind == "daily":
        payload = source_payload(date)
        file = artifact_paths(date)["digest"]
        if not file.is_file():
            return {"status": "not_generated", "date": date, "message": "已有来源但尚未生成日报，请按 Skill 分页写摘要"}
        markdown = file.read_text(encoding="utf-8")
        items = [asdict(item) for item in validate_frozen_digest(payload, markdown)]
        return {"status": "ready", "date": date, "digest_file": str(file),
                "generated_at": payload.get("generated_at"),
                "highlights": [item for item in items if item["highlight"]], **paginate(items, request)}
    if kind == "breaking":
        source_payload(date)
        code, result = render_breaking_report(date, integer(request.get("limit"), 8, 1, 20), 74)
    elif kind == "trend":
        if not (state_dir() / "state.db").is_file():
            return {"status": "empty", "date": date, "message": "没有本地采集历史，不能生成趋势结论"}
        code, result = render_trend_report(date, integer(request.get("days"), 7, 2, 31))
    else:
        raise ValueError("kind 仅支持 daily、breaking、trend")
    if code:
        return result
    report = json.loads(Path(result["json_file"]).read_text(encoding="utf-8"))
    if kind == "breaking":
        # 突发报告原有标题列表不包含正文，附回本条证据，供模型写来源摘要。
        payload = source_payload(date)
        by_url = {item["url"]: item for item in payload["items"]}
        report["items"] = [{**item, **reader_record(by_url[item["url"]])}
                           for item in report.get("items", [])]
        report.update(paginate(report["items"], request))
    return {"status": "ready", "kind": kind, "date": date, "report": report}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "prepare", "save", "query"))
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(512_001)
        if len(raw) > 512_000:
            raise ValueError("请求超过大小限制")
        request = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(request, dict):
            raise ValueError("请求必须是 JSON 对象")
        handlers = {"prepare": prepare_news, "save": save_digest, "query": query_news}
        result = doctor() if args.command == "doctor" else handlers[args.command](request)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get("status") in {"failed", "error"} else 0
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
