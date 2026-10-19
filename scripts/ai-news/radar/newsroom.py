"""Deterministic event clustering, verification, ranking, and alerting."""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .intelligence import classify_item
from .models import ContentItem

STORY_SCHEMA_VERSION = 1
EVENT_WINDOW_HOURS = 72
STANDARD_HIGHLIGHT_SCORE = 80.0
CORRECTION_HIGHLIGHT_SCORE = 74.0

HIGHLIGHT_SIGNAL_TYPES = {
    "security",
    "regulation",
    "pricing",
    "model_release",
    "api_update",
    "infrastructure",
    "open_source",
}

EVIDENCE_WEIGHT = {
    "first_party": 1.0,
    "reviewed_advisory": 0.96,
    "platform_metadata": 0.76,
    "editorial_synthesis": 0.64,
    "publisher_description": 0.56,
    "aggregated_summary": 0.42,
    "social_post": 0.32,
    "unclassified": 0.25,
}

IMPACT_WEIGHT = {
    "security": 1.0,
    "regulation": 0.92,
    "pricing": 0.88,
    "model_release": 0.86,
    "api_update": 0.84,
    "infrastructure": 0.78,
    "open_source": 0.72,
    "research": 0.58,
    "business": 0.54,
    "general": 0.38,
}

GENERIC_TOKENS = {
    "a",
    "ai",
    "an",
    "and",
    "announcing",
    "announcement",
    "for",
    "from",
    "in",
    "introducing",
    "launch",
    "launched",
    "new",
    "news",
    "of",
    "official",
    "on",
    "release",
    "released",
    "the",
    "to",
    "update",
    "with",
}

PRODUCT_TOKENS = {
    "agentcore",
    "bedrock",
    "chatgpt",
    "claude",
    "codex",
    "copilot",
    "cuda",
    "gemini",
    "gpt",
    "llama",
    "mcp",
    "qwen",
}

BRAND_TOKENS = {
    "alibaba",
    "amazon",
    "anthropic",
    "aws",
    "bytedance",
    "cloudflare",
    "cohere",
    "databricks",
    "deepmind",
    "deepseek",
    "google",
    "huggingface",
    "meta",
    "microsoft",
    "mistral",
    "nvidia",
    "openai",
}

DOMAIN_GENERIC_TOKENS = {
    "agent",
    "agents",
    "artificial",
    "compute",
    "data",
    "developer",
    "developers",
    "inference",
    "intelligence",
    "llm",
    "model",
    "models",
    "platform",
    "system",
    "systems",
    "training",
}

VERIFICATION_SCORE = {
    "cross_verified": 1.0,
    "multi_source": 0.8,
    "first_party": 0.72,
    "single_source": 0.42,
    "low_evidence": 0.2,
}

ROLE_NOVELTY = {"primary": 1.0, "update": 0.78, "corroborating": 0.38}


def _utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalized_text(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _title_skeleton(value: str) -> str:
    normalized = _normalized_text(value)
    normalized = re.sub(r"20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?", " ", normalized)
    normalized = re.sub(r"\b(?:update|updated|release|released)\b|更新|发布", " ", normalized)
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", normalized).strip()


def _title_tokens(value: str) -> set[str]:
    normalized = _normalized_text(value)
    tokens = {
        token.strip("._-+")
        for token in re.findall(r"[a-z0-9][a-z0-9._+-]*", normalized)
    }
    for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", normalized):
        tokens.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return {token for token in tokens if len(token) >= 2 and token not in GENERIC_TOKENS}


def _identifier_tokens(tokens: set[str]) -> set[str]:
    return {
        token
        for token in tokens
        if any(character.isdigit() for character in token) or token in PRODUCT_TOKENS
    }


def _is_version_token(token: str) -> bool:
    return re.fullmatch(
        r"(?:v?\d+(?:\.\d+)+|[a-z]{2,}(?:[-_.]?\d+)+(?:[-_.][a-z0-9]+)*)",
        token,
    ) is not None


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def _source_identity(record: dict[str, object]) -> str:
    host = (urlsplit(str(record.get("url", ""))).hostname or "").casefold()
    host = host.removeprefix("www.")
    source = _normalized_text(str(record.get("source", "")))
    for entity in record.get("entities", []):
        normalized_entity = _normalized_text(str(entity)).replace(" ", "")
        if normalized_entity and (
            normalized_entity in source.replace(" ", "")
            or normalized_entity in host.replace(".", "")
        ):
            return f"publisher:{normalized_entity}"
    source_type = str(record.get("source_type", ""))
    if source_type in {
        "youtube",
        "bilibili",
        "builders_x",
        "model_hub",
        "github_trending",
    }:
        return f"{host}:{source}"
    return host or source


def _cluster_similarity(record: dict[str, object], cluster: dict[str, object]) -> float:
    record_entities = set(str(value) for value in record.get("entities", []))
    cluster_entities = set(str(value) for value in cluster["entities"])
    if record_entities and cluster_entities and not record_entities & cluster_entities:
        return 0.0
    if str(record.get("signal_type")) != str(cluster["signal_type"]):
        return 0.0
    tokens = set(str(value) for value in record["_story_tokens"])
    cluster_tokens = set(str(value) for value in cluster["tokens"])
    identifiers = _identifier_tokens(tokens)
    cluster_identifiers = _identifier_tokens(cluster_tokens)
    topics = set(str(value) for value in record.get("topics", []))
    cluster_topics = set(str(value) for value in cluster["topics"])
    token_score = _jaccard(tokens, cluster_tokens)
    identifier_score = _jaccard(identifiers, cluster_identifiers)
    topic_score = _jaccard(topics, cluster_topics)
    entity_score = _jaccard(record_entities, cluster_entities)
    shared_tokens = tokens & cluster_tokens
    meaningful_shared = (
        shared_tokens - PRODUCT_TOKENS - BRAND_TOKENS - DOMAIN_GENERIC_TOKENS
    )
    has_version_match = any(_is_version_token(token) for token in shared_tokens)
    has_rare_match = any(
        len(token) >= 6 for token in meaningful_shared
    )
    first_member = cluster["members"][0]
    same_series_title = (
        len(_title_skeleton(str(record.get("title", "")))) >= 5
        and _title_skeleton(str(record.get("title", "")))
        == _title_skeleton(str(first_member.get("title", "")))
    )
    if (
        len(meaningful_shared) < 2
        and not has_version_match
        and not has_rare_match
        and not same_series_title
    ):
        return 0.0
    score = (
        token_score * 0.50
        + identifier_score * 0.24
        + topic_score * 0.14
        + entity_score * 0.12
    )
    if (
        _source_identity(record) == _source_identity(first_member)
        and not has_version_match
        and not same_series_title
        and token_score < 0.45
    ):
        return 0.0
    return score


def _new_cluster(record: dict[str, object]) -> dict[str, object]:
    published_at = _utc(str(record["published_at"]))
    return {
        "members": [record],
        "first_at": published_at,
        "last_at": published_at,
        "tokens": set(record["_story_tokens"]),
        "topics": set(record.get("topics", [])),
        "entities": set(record.get("entities", [])),
        "signal_type": str(record.get("signal_type", "general")),
    }


def _cluster_records(records: list[dict[str, object]]) -> list[dict[str, object]]:
    clusters: list[dict[str, object]] = []
    active: list[dict[str, object]] = []
    for record in sorted(records, key=lambda value: (_utc(str(value["published_at"])), str(value["id"]))):
        record["_story_tokens"] = sorted(_title_tokens(str(record.get("title", ""))))
        published_at = _utc(str(record["published_at"]))
        active = [
            cluster
            for cluster in active
            if (published_at - cluster["last_at"]).total_seconds() / 3600
            <= EVENT_WINDOW_HOURS
        ]
        candidates: list[tuple[float, dict[str, object]]] = []
        for cluster in active:
            similarity = _cluster_similarity(record, cluster)
            if similarity >= 0.40:
                candidates.append((similarity, cluster))
        if not candidates:
            cluster = _new_cluster(record)
            clusters.append(cluster)
            active.append(cluster)
            continue
        _, selected = max(
            candidates,
            key=lambda pair: (pair[0], -len(pair[1]["members"])),
        )
        selected["members"].append(record)
        selected["last_at"] = max(selected["last_at"], published_at)
        selected["tokens"].update(record["_story_tokens"])
        selected["topics"].update(record.get("topics", []))
        selected["entities"].update(record.get("entities", []))
    return clusters


def build_feedback_profile(
    feedback: list[tuple[ContentItem, str]],
) -> dict[str, object]:
    counters = {
        "signal_types": Counter(),
        "topics": Counter(),
        "entities": Counter(),
        "source_types": Counter(),
    }
    for item, value in feedback:
        direction = 1 if value == "useful" else -1
        labels = classify_item(item)
        counters["signal_types"][str(labels["signal_type"])] += direction
        counters["topics"].update(
            {str(topic): direction for topic in labels.get("topics", [])}
        )
        counters["entities"].update(
            {str(entity): direction for entity in labels.get("entities", [])}
        )
        counters["source_types"][item.source_type] += direction
    return {
        "samples": len(feedback),
        **{
            name: dict(sorted(counter.items()))
            for name, counter in counters.items()
        },
    }


def _personalization(record: dict[str, object], profile: dict[str, object]) -> float:
    if int(profile.get("samples", 0)) < 3:
        return 0.0
    score = 0.0
    signal_types = profile.get("signal_types", {})
    topics = profile.get("topics", {})
    entities = profile.get("entities", {})
    source_types = profile.get("source_types", {})
    if isinstance(signal_types, dict):
        score += float(signal_types.get(str(record.get("signal_type", "")), 0)) * 1.8
    if isinstance(topics, dict):
        score += sum(float(topics.get(str(value), 0)) for value in record.get("topics", []))
    if isinstance(entities, dict):
        score += sum(float(entities.get(str(value), 0)) for value in record.get("entities", [])) * 0.8
    if isinstance(source_types, dict):
        score += float(source_types.get(str(record.get("source_type", "")), 0)) * 0.6
    return max(-10.0, min(10.0, score))


def _verification(members: list[dict[str, object]]) -> tuple[str, int, int]:
    identities = {_source_identity(member) for member in members}
    weights = [
        EVIDENCE_WEIGHT.get(str(member.get("evidence_level", "unclassified")), 0.25)
        for member in members
    ]
    maximum = max(weights, default=0.0)
    if len(identities) >= 2 and maximum >= 0.9:
        status = "cross_verified"
    elif len(identities) >= 2:
        status = "multi_source"
    elif maximum >= 0.9:
        status = "first_party"
    elif maximum < 0.5:
        status = "low_evidence"
    else:
        status = "single_source"
    confidence = round(min(100, maximum * 65 + min(3, len(identities) - 1) * 12))
    return status, confidence, len(identities)


def _impact(record: dict[str, object]) -> float:
    base = IMPACT_WEIGHT.get(str(record.get("signal_type", "general")), 0.38)
    entity_bonus = min(0.08, len(record.get("entities", [])) * 0.025)
    audience_bonus = min(0.07, len(record.get("audiences", [])) * 0.02)
    return min(1.0, base + entity_bonus + audience_bonus)


def _specificity_adjustment(record: dict[str, object]) -> float:
    title = _normalized_text(str(record.get("title", ""))).strip()
    if re.fullmatch(r"(?:release\s+)?v?\d+(?:\.\d+){1,4}", title):
        return -15.0
    if re.search(r"·\s*\d{4}-\d{2}-\d{2}\s*更新$", title):
        return -6.0
    if re.match(
        r"(?:how\s+.+\b(?:built|transformed|uses?)\b|"
        r"run production\b|automated\s+.+\b(?:with|using)\b)",
        title,
    ):
        return -7.0
    if len(title) < 14 and str(record.get("signal_type")) == "general":
        return -5.0
    return 0.0


def _rank_reason(
    record: dict[str, object], age_hours: float, personalization: float
) -> list[str]:
    reasons: list[str] = []
    if EVIDENCE_WEIGHT.get(str(record.get("evidence_level")), 0.0) >= 0.9:
        reasons.append("authoritative_source")
    if age_hours <= 24:
        reasons.append("fresh")
    if IMPACT_WEIGHT.get(str(record.get("signal_type")), 0.0) >= 0.84:
        reasons.append("high_impact")
    if record.get("verification_status") == "cross_verified":
        reasons.append("cross_verified")
    if record.get("story_role") == "update":
        reasons.append("material_update")
    if record.get("change_type") in {"correction", "deprecation"}:
        reasons.append(str(record["change_type"]))
    if personalization >= 2:
        reasons.append("owner_interest")
    elif personalization <= -2:
        reasons.append("owner_downrank")
    return reasons or ["baseline_relevance"]


def _alert_level(record: dict[str, object], age_hours: float) -> str:
    source_text = str(record.get("source_text", "")).casefold()
    signal_type = str(record.get("signal_type", ""))
    score = float(record.get("rank_score", 0))
    verification = str(record.get("verification_status", ""))
    if _specificity_adjustment(record) <= -10:
        return "watch" if score >= 60 else "normal"
    if signal_type == "security" and re.search(r"\bcritical\b|严重|高危", source_text):
        return "critical"
    breaking_types = {"release", "advisory", "policy", "correction", "deprecation"}
    if (
        score >= 88
        and age_hours <= 24
        and verification not in {"low_evidence", "single_source"}
        and record.get("change_type") in breaking_types
    ):
        return "breaking"
    if score >= 74:
        return "high"
    if score >= 60:
        return "watch"
    return "normal"


def _recommended_highlight(record: dict[str, object]) -> bool:
    """Apply the absolute quality gate before editorial diversity selection."""
    if (
        record.get("source_text_status") != "available"
        or record.get("recency_status", "current") != "current"
        or record.get("story_role") != "primary"
        or record.get("verification_status") == "low_evidence"
        or _specificity_adjustment(record) <= -10
    ):
        return False

    alert_level = str(record.get("alert_level", "normal"))
    if alert_level in {"critical", "breaking"}:
        return True

    score = float(record.get("rank_score", 0))
    change_type = str(record.get("change_type", "report"))
    if change_type in {"correction", "deprecation"}:
        return score >= CORRECTION_HIGHLIGHT_SCORE

    return (
        score >= STANDARD_HIGHLIGHT_SCORE
        and str(record.get("signal_type", "general")) in HIGHLIGHT_SIGNAL_TYPES
    )


def _story_id(cluster: dict[str, object]) -> str:
    members = cluster["members"]
    first = min(members, key=lambda value: (_utc(str(value["published_at"])), str(value["id"])))
    basis = "|".join(
        (
            _utc(str(first["published_at"])).date().isoformat(),
            str(first.get("signal_type", "general")),
            str((first.get("entities") or [first.get("source", "")])[0]),
            str(first.get("id", "")),
        )
    )
    return f"evt-{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:16]}"


def _change_type(record: dict[str, object]) -> str:
    text = " ".join(
        (str(record.get("title", "")), str(record.get("source_text", ""))[:400])
    ).casefold()
    if re.search(r"\b(?:correction|corrected|erratum|revised)\b|更正|勘误|修正", text):
        return "correction"
    if re.search(r"\b(?:deprecat\w*|retir\w*|sunset\w*|end of life|eol)\b|弃用|下线|退役", text):
        return "deprecation"
    signal_type = str(record.get("signal_type", "general"))
    if signal_type == "security":
        return "advisory"
    if signal_type == "regulation":
        return "policy"
    if record.get("supersedes"):
        return "update"
    if signal_type in {"model_release", "api_update", "open_source"}:
        return "release"
    if record.get("story_role") == "update":
        return "update"
    return "report"


def enrich_and_rank_records(
    records: list[dict[str, object]],
    generated_at: datetime,
    feedback_profile: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    """Attach story graph metadata and return records in editorial rank order."""
    now = generated_at.astimezone(timezone.utc)
    profile = feedback_profile or {"samples": 0}
    clusters = _cluster_records(records)
    for cluster in clusters:
        members = list(cluster["members"])
        event_id = _story_id(cluster)
        verification_status, confidence, diversity = _verification(members)
        primary = max(
            members,
            key=lambda value: (
                EVIDENCE_WEIGHT.get(str(value.get("evidence_level", "unclassified")), 0.25),
                value.get("source_text_status") == "available",
                _utc(str(value["published_at"])),
                str(value.get("id", "")),
            ),
        )
        chronological = sorted(
            members,
            key=lambda value: (_utc(str(value["published_at"])), str(value.get("id", ""))),
        )
        previous_by_source: dict[str, str] = {}
        for version, record in enumerate(chronological, start=1):
            identity = _source_identity(record)
            prior = previous_by_source.get(identity)
            if record is primary:
                role = "primary"
            elif prior:
                role = "update"
            else:
                role = "corroborating"
            previous_by_source[identity] = str(record.get("id", ""))
            record.update(
                {
                    "event_id": event_id,
                    "story_role": role,
                    "story_version": version,
                    "story_items": len(members),
                    "source_diversity": diversity,
                    "verification_status": verification_status,
                    "confidence_score": confidence,
                    "event_first_seen": cluster["first_at"].isoformat(),
                    "event_last_updated": cluster["last_at"].isoformat(),
                    "supersedes": prior or "",
                }
            )
            record["change_type"] = _change_type(record)

    for record in records:
        published_at = _utc(str(record["published_at"]))
        age_hours = max(0.0, (now - published_at).total_seconds() / 3600)
        authority = EVIDENCE_WEIGHT.get(str(record.get("evidence_level", "unclassified")), 0.25) * 30
        freshness = 25 * math.pow(2, -age_hours / 72)
        impact = _impact(record) * 20
        verification = VERIFICATION_SCORE.get(str(record.get("verification_status")), 0.2) * 15
        novelty = ROLE_NOVELTY.get(str(record.get("story_role")), 0.38) * 10
        personalization = _personalization(record, profile)
        specificity = _specificity_adjustment(record)
        components = {
            "authority": round(authority, 2),
            "freshness": round(freshness, 2),
            "impact": round(impact, 2),
            "verification": round(verification, 2),
            "novelty": round(novelty, 2),
            "personalization": round(personalization, 2),
            "specificity_adjustment": round(specificity, 2),
        }
        record["rank_components"] = components
        record["rank_score"] = round(max(0.0, min(100.0, sum(components.values()))), 2)
        record["rank_reason"] = _rank_reason(record, age_hours, personalization)
        record["alert_level"] = _alert_level(record, age_hours)
        record["recommended_highlight"] = _recommended_highlight(record)
        record.pop("_story_tokens", None)

    ordered = sorted(
        records,
        key=lambda value: (
            -float(value.get("rank_score", 0)),
            -_utc(str(value["published_at"])).timestamp(),
            str(value.get("id", "")),
        ),
    )
    for position, record in enumerate(ordered, start=1):
        record["rank_position"] = position
    return ordered


def build_breaking_report(
    source_payload: dict[str, object],
    *,
    limit: int = 10,
    minimum_score: float = 74,
) -> tuple[dict[str, object], str]:
    if not 1 <= limit <= 50:
        raise ValueError("breaking report limit must be 1 through 50")
    if not 0 <= minimum_score <= 100:
        raise ValueError("breaking report minimum score must be 0 through 100")
    items = source_payload.get("items")
    if not isinstance(items, list):
        raise ValueError("source payload items must be an array")
    leaders: dict[str, dict[str, object]] = {}
    for item in items:
        if not isinstance(item, dict) or float(item.get("rank_score", 0)) < minimum_score:
            continue
        event_id = str(item.get("event_id") or item.get("id"))
        existing = leaders.get(event_id)
        if existing is None or float(item.get("rank_score", 0)) > float(existing.get("rank_score", 0)):
            leaders[event_id] = item
    candidates = sorted(
        leaders.values(),
        key=lambda value: (-float(value.get("rank_score", 0)), int(value.get("rank_position", 0))),
    )

    def coverage_bucket(item: dict[str, object]) -> str:
        title = str(item.get("title", ""))
        if item.get("source_type") == "security_advisory":
            product = title.split("·", 1)[-1].split(":", 1)[0].strip()
            if product:
                return product.casefold()
        entities = item.get("entities", [])
        if isinstance(entities, list) and entities:
            return str(entities[0]).casefold()
        return str(item.get("source", "")).casefold()

    selected: list[dict[str, object]] = []
    deferred: list[dict[str, object]] = []
    bucket_counts: Counter[str] = Counter()
    signal_counts: Counter[str] = Counter()
    publisher_counts: Counter[str] = Counter()
    for item in candidates:
        bucket = coverage_bucket(item)
        signal = str(item.get("signal_type", "general"))
        publisher = str(item.get("source", "unknown")).casefold()
        constrained = (
            bucket_counts[bucket] >= 2
            or signal_counts[signal] >= 4
            or publisher_counts[publisher] >= 3
        )
        if constrained and item.get("alert_level") != "critical":
            deferred.append(item)
            continue
        selected.append(item)
        bucket_counts[bucket] += 1
        signal_counts[signal] += 1
        publisher_counts[publisher] += 1
        if len(selected) == limit:
            break
    if len(selected) < limit:
        selected_ids = {str(item.get("id")) for item in selected}
        for item in deferred:
            if str(item.get("id")) in selected_ids:
                continue
            selected.append(item)
            if len(selected) == limit:
                break
    report_items = [
        {
            "event_id": item.get("event_id"),
            "title": item.get("title"),
            "url": item.get("url"),
            "source": item.get("source"),
            "rank_score": item.get("rank_score"),
            "alert_level": item.get("alert_level"),
            "verification_status": item.get("verification_status"),
            "confidence_score": item.get("confidence_score"),
            "story_items": item.get("story_items"),
            "source_diversity": item.get("source_diversity"),
            "rank_reason": item.get("rank_reason", []),
            "change_type": item.get("change_type"),
            "signal_type": item.get("signal_type"),
            "source_type": item.get("source_type"),
            "entities": item.get("entities", []),
        }
        for item in selected
    ]
    report = {
        "schema_version": STORY_SCHEMA_VERSION,
        "status": "ok",
        "date": source_payload.get("date"),
        "minimum_score": minimum_score,
        "candidate_events": len(candidates),
        "total": len(report_items),
        "selection_policy": {
            "event_leaders_only": True,
            "max_per_coverage_bucket": 2,
            "max_per_signal_type": 4,
            "max_per_publisher": 3,
            "critical_bypasses_caps": True,
            "fill_deferred_when_needed": True,
        },
        "items": report_items,
    }
    markdown = [
        f"# AI 前哨高优先级事件 · {source_payload.get('date', '')}",
        "",
        (
            f"门槛 {minimum_score:g} 分，从 {len(candidates)} 个候选事件中按边际多样性"
            f"选出 {len(report_items)} 个独立事件。"
        ),
        "",
    ]
    for index, item in enumerate(report_items, start=1):
        markdown.extend(
            [
                f"## {index}. [{item['title']}]({item['url']})",
                "",
                (
                    f"- 评分：{item['rank_score']} · {item['alert_level']} · "
                    f"{item['change_type']} · {item['verification_status']}"
                    f"（置信 {item['confidence_score']}）"
                ),
                (
                    f"- 事件链：{item['story_items']} 条信号 · "
                    f"{item['source_diversity']} 个独立来源"
                ),
                f"- 排序依据：{', '.join(item['rank_reason'])}",
                "",
            ]
        )
    return report, "\n".join(markdown).rstrip() + "\n"


def newsroom_summary(records: list[dict[str, object]]) -> dict[str, object]:
    events = {str(record.get("event_id")) for record in records}
    verification = Counter(str(record.get("verification_status")) for record in records)
    alerts = Counter(str(record.get("alert_level")) for record in records)
    languages = Counter(str(record.get("language", "unknown")) for record in records)
    return {
        "schema_version": STORY_SCHEMA_VERSION,
        "events": len(events),
        "signals": len(records),
        "compression_ratio": round(len(records) / len(events), 2) if events else 0,
        "cross_verified_events": len(
            {
                str(record.get("event_id"))
                for record in records
                if record.get("verification_status") == "cross_verified"
            }
        ),
        "verification": dict(sorted(verification.items())),
        "alerts": dict(sorted(alerts.items())),
        "languages": dict(sorted(languages.items())),
        "ranking_model": "authority+freshness+impact+verification+novelty+owner_feedback",
        "fingerprint": hashlib.sha256(
            json.dumps(
                [
                    (record.get("id"), record.get("event_id"), record.get("rank_score"))
                    for record in records
                ],
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest(),
    }
