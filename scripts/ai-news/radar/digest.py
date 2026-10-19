"""Validate evidence-bounded frozen Markdown without channel rendering."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

MAX_DAILY_HIGHLIGHTS = 6
SOURCE_ORDER = {
    "official_news": 0,
    "youtube": 1,
    "bilibili": 2,
    "aihot": 3,
    "github_trending": 4,
    "security_advisory": 5,
    "model_hub": 6,
    "industry_digest": 7,
    "builders_x": 8,
}
ITEM_PATTERN = re.compile(
    r"^###\s+\d+\.\s+\[(?P<title>.+)]\((?P<url>https?://[^)]+)\)\s*$"
)
FIELD_PREFIXES = {
    "source": "- 来源：",
    "highlight": "- 重点：",
    "summary": "- 来源摘要：",
    "recommendation": "- 💡 推荐理由：",
}
FORBIDDEN_PREFIXES = ("- 事实摘要：", "- 字幕摘要：")
RECOVERED_PREFIX_RE = re.compile(r"^补录（\d{4}-\d{2}-\d{2}）：")
ARABIC_QUANTITY_RE = re.compile(
    r"(?<![A-Za-z0-9])(?P<number>\d[\d,]*(?:\.\d+)?)"
    r"(?:\s*(?P<scale>thousand|million|billion|万|亿))?",
    re.IGNORECASE,
)
CHINESE_QUANTITY_RE = re.compile(
    r"(?P<number>[零〇一二两三四五六七八九十百]+)"
    r"(?P<scale>万|亿)?\s*"
    r"(?P<unit>项|个|条|类|倍|年|月|天|秒|种|座|单|英里|字符|张|段|帧|美元|欧元|测试)"
)
ENGLISH_NUMBER_RE = re.compile(
    r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|"
    r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|"
    r"billion)(?:[ -]+(?:one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|"
    r"nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|"
    r"thousand|million|billion))*\b",
    re.IGNORECASE,
)
ENGLISH_MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}
ENGLISH_NUMBER_VALUES = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
SCALE_VALUES = {
    "thousand": Decimal(1_000),
    "million": Decimal(1_000_000),
    "billion": Decimal(1_000_000_000),
    "万": Decimal(10_000),
    "亿": Decimal(100_000_000),
}


@dataclass(frozen=True, slots=True)
class FrozenItem:
    item_id: str
    source_type: str
    source: str
    title: str
    url: str
    summary: str
    recommendation: str
    highlight: bool
    recency_status: str = "current"
    signal_type: str = "general"
    evidence_level: str = "unclassified"
    topics: tuple[str, ...] = ()
    audiences: tuple[str, ...] = ()
    language: str = "en"
    event_id: str = ""
    story_role: str = "primary"
    story_items: int = 1
    source_diversity: int = 1
    verification_status: str = "single_source"
    confidence_score: int = 0
    rank_score: float = 0.0
    rank_reason: tuple[str, ...] = ()
    alert_level: str = "normal"
    change_type: str = "report"


def _english_number(value: str) -> Decimal | None:
    total = 0
    current = 0
    for token in re.split(r"[ -]+", value.casefold()):
        if token in ENGLISH_NUMBER_VALUES:
            current += ENGLISH_NUMBER_VALUES[token]
        elif token == "hundred":
            current = max(current, 1) * 100
        elif token in {"thousand", "million", "billion"}:
            scale = int(SCALE_VALUES[token])
            total += max(current, 1) * scale
            current = 0
        else:
            return None
    return Decimal(total + current)


def _chinese_number(value: str) -> Decimal | None:
    digits = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    units = {"十": 10, "百": 100}
    total = 0
    current = 0
    for char in value:
        if char in digits:
            current = digits[char]
        elif char in units:
            total += max(current, 1) * units[char]
            current = 0
        else:
            return None
    return Decimal(total + current)


def _numeric_concepts(value: str) -> set[Decimal]:
    normalized = value.replace("，", ",")
    concepts: set[Decimal] = set()
    for match in ARABIC_QUANTITY_RE.finditer(normalized):
        try:
            number = Decimal(match.group("number").replace(",", ""))
        except InvalidOperation:
            continue
        scale = (match.group("scale") or "").casefold()
        concepts.add(number * SCALE_VALUES.get(scale, 1))
    for match in CHINESE_QUANTITY_RE.finditer(normalized):
        number = _chinese_number(match.group("number"))
        if number is not None:
            if number == 1 and match.group("unit") in {"项", "个", "条", "种"}:
                continue
            concepts.add(number * SCALE_VALUES.get(match.group("scale") or "", 1))
    for match in ENGLISH_NUMBER_RE.finditer(normalized):
        number = _english_number(match.group(0))
        if number is not None:
            concepts.add(number)
    lowered = normalized.casefold()
    concepts.update(
        Decimal(month)
        for name, month in ENGLISH_MONTHS.items()
        if re.search(rf"\b{name}\b", lowered)
    )
    if re.search(r"\bhalf (?:a )?century\b|半个多?世纪", lowered):
        concepts.add(Decimal(50))
    return concepts


def _validate_numeric_evidence(record: dict, summary: str) -> None:
    summary_without_recency = RECOVERED_PREFIX_RE.sub("", summary, count=1)
    unsupported = _numeric_concepts(summary_without_recency) - _numeric_concepts(
        str(record.get("source_text", ""))
    )
    if unsupported:
        values = ", ".join(format(value, "f") for value in sorted(unsupported))
        raise ValueError(
            f"source summary contains unsupported numeric evidence ({values}): "
            f"{record.get('title', '')}"
        )


def _parse_markdown(markdown: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    last_field: str | None = None

    def flush() -> None:
        nonlocal current, last_field
        if current is not None:
            items.append(current)
        current = None
        last_field = None

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        match = ITEM_PATTERN.match(line)
        if match:
            flush()
            current = {"title": match.group("title"), "url": match.group("url")}
            continue
        if current is None:
            continue
        if line.startswith(FORBIDDEN_PREFIXES):
            raise ValueError("frozen digest must use 来源摘要, not 事实摘要 or 字幕摘要")
        matched_field = False
        for key, prefix in FIELD_PREFIXES.items():
            if line.startswith(prefix):
                current[key] = line[len(prefix) :].strip()
                last_field = key
                matched_field = True
                break
        if matched_field or not line or line.startswith("#"):
            continue
        if line.startswith("-"):
            last_field = None
            continue
        if last_field in {"summary", "recommendation"}:
            current[last_field] = f"{current.get(last_field, '')} {line}".strip()
    flush()
    if not items:
        raise ValueError("frozen digest contains no parseable items")
    return items


def validate_frozen_digest(source_payload: dict, markdown: str) -> list[FrozenItem]:
    records = source_payload.get("items")
    if not isinstance(records, list):
        raise ValueError("source payload items must be an array")
    by_url: dict[str, dict] = {}
    for record in records:
        if not isinstance(record, dict) or not record.get("url"):
            raise ValueError("source payload contains an invalid record")
        url = str(record["url"])
        if url in by_url:
            raise ValueError("source payload contains duplicate URLs")
        by_url[url] = record

    parsed = _parse_markdown(markdown)
    parsed_urls = [item.get("url", "") for item in parsed]
    if len(parsed_urls) != len(set(parsed_urls)):
        raise ValueError("frozen digest contains duplicate URLs")
    if set(parsed_urls) != set(by_url):
        missing = len(set(by_url) - set(parsed_urls))
        invented = len(set(parsed_urls) - set(by_url))
        raise ValueError(f"frozen digest source mismatch: missing={missing}, invented={invented}")

    frozen: list[FrozenItem] = []
    highlighted_events: set[str] = set()
    highlight_count = 0
    for item in parsed:
        record = by_url[item["url"]]
        required = ("source", "highlight", "summary")
        if any(not item.get(field, "").strip() for field in required):
            raise ValueError("every frozen item requires source, highlight, and source summary")
        if item["title"].strip() != str(record.get("title", "")).strip():
            raise ValueError("frozen digest title differs from source payload")
        if item["source"].strip() != str(record.get("source", "")).strip():
            raise ValueError("frozen digest source differs from source payload")
        if item["highlight"] not in {"是", "否"}:
            raise ValueError("highlight must be 是 or 否")

        status = str(record.get("source_text_status", ""))
        if status == "unavailable":
            expected = f"不可用（{record.get('unavailable_reason', '')}）"
            if item["summary"] != expected:
                raise ValueError("unavailable source must keep its exact unavailable reason")
            if item["highlight"] == "是":
                raise ValueError("unavailable source cannot be a highlight")
        elif status == "available":
            if item["summary"].startswith("不可用"):
                raise ValueError("available source requires a source-bounded summary")
            _validate_numeric_evidence(record, item["summary"])
        else:
            raise ValueError("source record has an unknown source_text_status")

        recency_status = str(record.get("recency_status", "current"))
        if recency_status not in {"current", "recovered"}:
            raise ValueError("source record has an unknown recency_status")
        source_type = str(record.get("source_type", ""))
        if item["highlight"] == "是":
            if recency_status != "current":
                raise ValueError("recovered source cannot be a highlight")
            if record.get("verification_status") == "low_evidence":
                raise ValueError("low-evidence source cannot be a highlight")
            if (
                "recommended_highlight" in record
                and not record.get("recommended_highlight")
            ):
                raise ValueError("highlight must pass the deterministic quality gate")
            event_id = str(record.get("event_id", "")).strip()
            if event_id and event_id in highlighted_events:
                raise ValueError("only one highlight is allowed per event")
            if event_id:
                highlighted_events.add(event_id)
            highlight_count += 1
            if highlight_count > MAX_DAILY_HIGHLIGHTS:
                raise ValueError(
                    f"daily highlights cannot exceed {MAX_DAILY_HIGHLIGHTS}"
                )

        recommendation = item.get("recommendation", "").strip()
        source_recommendation = str(record.get("recommendation", "")).strip()
        if recommendation and recommendation != source_recommendation:
            raise ValueError("recommendation must match the source payload exactly")
        frozen.append(
            FrozenItem(
                item_id=str(record.get("id", "")),
                source_type=source_type,
                source=item["source"].strip(),
                title=item["title"].strip(),
                url=item["url"].strip(),
                summary=item["summary"].strip(),
                recommendation=recommendation,
                highlight=item["highlight"] == "是",
                recency_status=recency_status,
                signal_type=str(record.get("signal_type", "general")),
                evidence_level=str(record.get("evidence_level", "unclassified")),
                topics=tuple(
                    str(topic)
                    for topic in record.get("topics", [])
                    if isinstance(topic, str)
                ),
                audiences=tuple(
                    str(audience)
                    for audience in record.get("audiences", [])
                    if isinstance(audience, str)
                ),
                language=str(record.get("language", "en")),
                event_id=str(record.get("event_id", "")),
                story_role=str(record.get("story_role", "primary")),
                story_items=int(record.get("story_items", 1)),
                source_diversity=int(record.get("source_diversity", 1)),
                verification_status=str(
                    record.get("verification_status", "single_source")
                ),
                confidence_score=int(record.get("confidence_score", 0)),
                rank_score=float(record.get("rank_score", 0)),
                rank_reason=tuple(
                    str(reason)
                    for reason in record.get("rank_reason", [])
                    if isinstance(reason, str)
                ),
                alert_level=str(record.get("alert_level", "normal")),
                change_type=str(record.get("change_type", "report")),
            )
        )
    return frozen
