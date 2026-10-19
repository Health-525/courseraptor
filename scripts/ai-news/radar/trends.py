"""Build deterministic multi-day intelligence trend reports."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from .intelligence import classify_item
from .newsroom import enrich_and_rank_records, newsroom_summary
from .source_material import source_text_status
from .storage import Storage


def build_trend_report(storage: Storage, end_date: str, days: int = 7) -> tuple[dict[str, object], str]:
    if not 2 <= days <= 31:
        raise ValueError("trend report days must be 2 through 31")
    try:
        end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError("trend report date must be YYYY-MM-DD") from error
    window_end = end + timedelta(days=1)
    window_start = window_end - timedelta(days=days)
    comparison_start = window_start - timedelta(days=days)
    all_items = storage.items_since(comparison_start)
    items = [
        item for item in all_items if window_start <= item.published_at < window_end
    ]
    previous_items = [
        item for item in all_items if comparison_start <= item.published_at < window_start
    ]
    signals: Counter[str] = Counter()
    topics: Counter[str] = Counter()
    entities: Counter[str] = Counter()
    audiences: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    source_types: Counter[str] = Counter()
    previous_signals: Counter[str] = Counter()
    previous_topics: Counter[str] = Counter()
    previous_entities: Counter[str] = Counter()
    available = 0
    records: list[dict[str, object]] = []
    for item in items:
        labels = classify_item(item)
        signals[str(labels["signal_type"])] += 1
        topics.update(str(topic) for topic in labels["topics"])
        entities.update(str(entity) for entity in labels["entities"])
        audiences.update(str(audience) for audience in labels["audiences"])
        languages[str(labels["language"])] += 1
        sources[item.source] += 1
        source_types[item.source_type] += 1
        status, source_text, reason = source_text_status(item.raw_source_text)
        available += status == "available"
        record: dict[str, object] = {
            "id": item.item_id,
            "source_type": item.source_type,
            "source": item.source,
            "title": item.title,
            "published_at": item.published_at.isoformat(),
            "url": item.url,
            "source_text_status": status,
            "source_text": source_text,
            "unavailable_reason": reason,
        }
        record.update(labels)
        records.append(record)
    for item in previous_items:
        labels = classify_item(item)
        previous_signals[str(labels["signal_type"])] += 1
        previous_topics.update(str(topic) for topic in labels["topics"])
        previous_entities.update(str(entity) for entity in labels["entities"])
    ranked = enrich_and_rank_records(records, window_end)
    newsroom = newsroom_summary(ranked)
    seen_events: set[str] = set()
    top_events: list[dict[str, object]] = []
    for record in ranked:
        event_id = str(record.get("event_id"))
        if event_id in seen_events:
            continue
        seen_events.add(event_id)
        top_events.append(
            {
                "event_id": event_id,
                "title": record.get("title"),
                "url": record.get("url"),
                "rank_score": record.get("rank_score"),
                "alert_level": record.get("alert_level"),
                "verification_status": record.get("verification_status"),
                "story_items": record.get("story_items"),
                "source_diversity": record.get("source_diversity"),
            }
        )
        if len(top_events) == 10:
            break
    feedback = {"useful": 0, "not_useful": 0}
    operations = storage.collection_run_summary(window_start.date().isoformat())

    def top(counter: Counter[str], limit: int = 10) -> list[dict[str, object]]:
        return [{"name": name, "count": count} for name, count in counter.most_common(limit)]

    def momentum(
        current: Counter[str], previous: Counter[str], limit: int = 10
    ) -> list[dict[str, object]]:
        ranked = sorted(
            current,
            key=lambda name: (
                -(current[name] - previous[name]),
                -current[name],
                name,
            ),
        )[:limit]
        values: list[dict[str, object]] = []
        for name in ranked:
            current_count = current[name]
            previous_count = previous[name]
            delta = current_count - previous_count
            if previous_count == 0:
                direction = "new"
                growth_ratio: float | None = None
            elif delta > 0:
                direction = "rising"
                growth_ratio = round(delta / previous_count, 4)
            elif delta < 0:
                direction = "falling"
                growth_ratio = round(delta / previous_count, 4)
            else:
                direction = "steady"
                growth_ratio = 0.0
            values.append(
                {
                    "name": name,
                    "current": current_count,
                    "previous": previous_count,
                    "delta": delta,
                    "growth_ratio": growth_ratio,
                    "direction": direction,
                }
            )
        return values

    report: dict[str, object] = {
        "schema_version": 2,
        "status": "ok",
        "window": {"start": window_start.date().isoformat(), "end": end_date, "days": days},
        "comparison_window": {
            "start": comparison_start.date().isoformat(),
            "end": (window_start - timedelta(days=1)).date().isoformat(),
            "days": days,
            "total": len(previous_items),
        },
        "total": len(items),
        "available": available,
        "unavailable": len(items) - available,
        "availability_ratio": round(available / len(items), 4) if items else 0,
        "signal_types": top(signals),
        "topics": top(topics),
        "entities": top(entities),
        "audiences": top(audiences),
        "languages": top(languages),
        "source_types": top(source_types),
        "sources": top(sources),
        "feedback": feedback,
        "operations": operations,
        "newsroom": newsroom,
        "top_events": top_events,
        "momentum": {
            "signal_types": momentum(signals, previous_signals),
            "topics": momentum(topics, previous_topics),
            "entities": momentum(entities, previous_entities),
        },
    }

    def lines(title: str, values: list[dict[str, object]]) -> list[str]:
        return [f"## {title}", ""] + (
            [f"- {value['name']}：{value['count']}" for value in values]
            if values
            else ["- 暂无数据"]
        )

    markdown = [
        f"# AI 情报趋势｜{window_start.date().isoformat()} 至 {end_date}",
        "",
        f"共 {len(items)} 条信号，可用证据 {available} 条，不可用 {len(items) - available} 条。",
        "",
    ]
    markdown.extend(["## 核心事件", ""])
    markdown.extend(
        (
            f"- [{event['title']}]({event['url']})：{event['rank_score']} 分 · "
            f"{event['alert_level']} · {event['verification_status']} · "
            f"{event['story_items']} 条/{event['source_diversity']} 源"
        )
        for event in top_events
    )
    if not top_events:
        markdown.append("- 暂无数据")
    markdown.append("")
    markdown.extend(["## 趋势动量（对比前一等长窗口）", ""])
    markdown.extend(
        (
            f"- {value['name']}：{value['current']} vs {value['previous']} "
            f"({value['delta']:+d}, {value['direction']})"
        )
        for value in report["momentum"]["topics"]
    )
    if not report["momentum"]["topics"]:
        markdown.append("- 暂无数据")
    markdown.append("")
    markdown.extend(lines("信号类型", report["signal_types"]))
    markdown.extend([""] + lines("主题", report["topics"]))
    markdown.extend([""] + lines("重点实体", report["entities"]))
    markdown.extend([""] + lines("受众匹配", report["audiences"]))
    markdown.extend([""] + lines("语言", report["languages"]))
    markdown.extend([""] + lines("来源类型", report["source_types"]))
    markdown.extend(
        [
            "",
            "## 反馈",
            "",
            f"- 有用：{feedback['useful']}",
            f"- 无用：{feedback['not_useful']}",
            "",
            "## 运行质量",
            "",
            f"- 采集运行：{operations['runs']}",
            f"- 失败运行：{operations['failed_runs']}",
            f"- 来源失败：{operations['source_failures']}",
            f"- 证据可用率：{operations['availability_ratio']:.1%}",
        ]
    )
    return report, "\n".join(markdown) + "\n"
