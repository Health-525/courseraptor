"""Deterministic intelligence labels and provenance for collected signals."""

from __future__ import annotations

import hashlib
import json
import re

from .models import ContentItem

EVIDENCE_LEVELS = {
    "official_news": "first_party",
    "security_advisory": "reviewed_advisory",
    "model_hub": "platform_metadata",
    "industry_digest": "editorial_synthesis",
    "github_trending": "platform_metadata",
    "youtube": "publisher_description",
    "bilibili": "publisher_description",
    "aihot": "aggregated_summary",
    "builders_x": "social_post",
}

SIGNAL_PATTERNS = (
    ("security", r"\b(?:cve|ghsa|vulnerab|security|exploit|attack)\b|漏洞|安全|攻击"),
    ("regulation", r"\b(?:regulat|compliance|(?:ai|artificial intelligence) policy|law|ai act|governance)\b|监管|合规|政策|法规|治理"),
    ("pricing", r"\b(?:pric|cost|billing|discount)\b|价格|定价|计费|降价"),
    ("api_update", r"\b(?:api|sdk|changelog|deprecat|endpoint|tool call)\b|接口|弃用|工具调用"),
    ("model_release", r"\b(?:model|weights?|checkpoint|multimodal|reasoning)\b|模型|权重|多模态|推理"),
    ("open_source", r"\b(?:open[ -]source|github|repository|license)\b|开源|仓库"),
    ("infrastructure", r"\b(?:inference|training|gpu|compute|latency|throughput|agentcore)\b|基础设施|训练|延迟|吞吐"),
    ("research", r"\b(?:research|paper|benchmark|evaluation|evals?)\b|研究|论文|基准|评测"),
    ("business", r"\b(?:enterprise|customer|funding|acqui|partnership|revenue)\b|企业|客户|融资|收购|合作"),
)

TOPIC_PATTERNS = (
    ("agents", r"\b(?:agents?|agentic|mcp|tool call)\b|智能体|工具调用"),
    ("coding", r"\b(?:coding|code generation|developer tools?|codex|cursor)\b|编程|代码生成|开发者工具"),
    ("models", r"\b(?:llm|models?|weights?|checkpoint|multimodal|reasoning)\b|大模型|模型|权重|多模态|推理"),
    ("infrastructure", r"\b(?:inference|training|gpu|compute|latency|throughput)\b|基础设施|训练|延迟|吞吐"),
    ("security", r"\b(?:cve|ghsa|vulnerab|security|exploit)\b|漏洞|安全"),
    ("governance", r"\b(?:regulat|compliance|(?:ai|artificial intelligence) policy|law|ai act|governance)\b|监管|合规|政策|法规|治理"),
    ("robotics", r"\b(?:robotics?|autonomous|physical ai)\b|机器人|自动驾驶|具身"),
    ("media", r"\b(?:image|video|audio|speech|vision)\b|图像|视频|音频|语音|视觉"),
)

ENTITY_PATTERNS = {
    "OpenAI": r"\b(?:openai|chatgpt|codex)\b",
    "Anthropic": r"\b(?:anthropic|claude)\b",
    "Google": r"\b(?:google|gemini|deepmind|vertex)\b",
    "Meta": r"\b(?:meta|llama)\b",
    "Microsoft": r"\b(?:microsoft|azure|copilot)\b",
    "AWS": r"\b(?:aws|amazon bedrock|sagemaker|agentcore)\b",
    "NVIDIA": r"\b(?:nvidia|cuda|nemotron)\b",
    "Qwen": r"\bqwen\b|通义千问|阿里云百炼",
    "DeepSeek": r"\bdeepseek\b",
    "ByteDance": r"\b(?:bytedance|seed|volcengine)\b|字节|火山引擎",
    "Mistral": r"\bmistral\b",
    "Cohere": r"\bcohere\b",
    "Hugging Face": r"\bhugging ?face\b",
}

SIGNAL_AUDIENCES = {
    "security": ["security", "engineering", "management"],
    "regulation": ["management", "legal", "product"],
    "pricing": ["management", "product", "engineering"],
    "api_update": ["engineering", "product"],
    "model_release": ["engineering", "product"],
    "open_source": ["engineering"],
    "infrastructure": ["engineering", "management"],
    "research": ["research", "engineering"],
    "business": ["management", "product"],
    "general": ["management"],
}


def _matches(pattern: str, text: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE) is not None


def detect_language(value: str) -> str:
    if re.search(r"[\u3040-\u30ff]", value):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", value):
        return "ko"
    if re.search(r"[\u4e00-\u9fff]", value):
        return "zh"
    if re.search(r"[\u0400-\u04ff]", value):
        return "ru"
    return "en"


def classify_item(item: ContentItem) -> dict[str, object]:
    text = " ".join((item.source, item.title, item.raw_source_text))
    explicit_signal = {
        "security_advisory": "security",
        "model_hub": "model_release",
        "github_trending": "open_source",
    }.get(item.source_type)
    title_text = " ".join((item.source, item.title))
    signal_type = explicit_signal or next(
        (name for name, pattern in SIGNAL_PATTERNS if _matches(pattern, title_text)),
        "general",
    )
    if signal_type == "general" and item.extra in {
        "官方 Release Notes",
        "官方 Changelog",
    }:
        signal_type = "api_update"
    topics = [name for name, pattern in TOPIC_PATTERNS if _matches(pattern, text)]
    entities = [name for name, pattern in ENTITY_PATTERNS.items() if _matches(pattern, text)]
    if not entities and item.source_type in {"official_news", "model_hub"}:
        entities = [item.source.split("·", 1)[-1].strip()]
    normalized_title = re.sub(
        r"[^a-z0-9\u4e00-\u9fff]+", " ", item.title.casefold()
    ).strip()
    event_basis = "|".join(
        (
            item.published_at.date().isoformat(),
            entities[0] if entities else item.source,
            signal_type,
            normalized_title,
        )
    )
    return {
        "event_id": f"evt-{hashlib.sha256(event_basis.encode('utf-8')).hexdigest()[:16]}",
        "signal_type": signal_type,
        "topics": topics or ["general_ai"],
        "entities": entities,
        "audiences": SIGNAL_AUDIENCES[signal_type],
        "language": detect_language(item.title),
        "evidence_level": EVIDENCE_LEVELS.get(item.source_type, "unclassified"),
        "source_text_sha256": hashlib.sha256(
            item.raw_source_text.encode("utf-8")
        ).hexdigest(),
    }


def verify_source_payload(payload: dict[str, object]) -> None:
    schema_version = payload.get("schema_version", 1)
    if schema_version == 1:
        return
    if schema_version != 2:
        raise ValueError("source payload schema version is unsupported")
    records = payload.get("items")
    if not isinstance(records, list):
        raise ValueError("source payload items must be an array")
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("source payload contains an invalid record")
        expected_text_hash = hashlib.sha256(
            str(record.get("source_text", "")).encode("utf-8")
        ).hexdigest()
        if record.get("source_text_sha256") != expected_text_hash:
            raise ValueError("source payload text provenance mismatch")
        expected_record_hash = hashlib.sha256(
            json.dumps(
                {key: value for key, value in record.items() if key != "record_sha256"},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        if record.get("record_sha256") != expected_record_hash:
            raise ValueError("source payload record provenance mismatch")
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("source payload provenance is missing")
    expected_set_hash = hashlib.sha256(
        json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    if provenance.get("source_set_sha256") != expected_set_hash:
        raise ValueError("source payload set provenance mismatch")
    if "newsroom" in payload:
        newsroom = payload.get("newsroom")
        if not isinstance(newsroom, dict):
            raise ValueError("source payload newsroom summary is invalid")
        expected_newsroom_hash = hashlib.sha256(
            json.dumps(newsroom, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if provenance.get("newsroom_sha256") != expected_newsroom_hash:
            raise ValueError("source payload newsroom provenance mismatch")
