"""Clean publisher-provided text without rewriting its evidence."""

from __future__ import annotations

import re

URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
SPACE_RE = re.compile(r"[ \t]+")
PROMOTIONAL_LINE_RE = re.compile(
    r"^(?:subscribe|follow (?:me|us)|sponsor(?:ed)?|use (?:my|code)|"
    r"join (?:my|our)|support (?:me|us)|newsletter|discord|twitter|"
    r"instagram|tiktok|linkedin|patreon|merch|chapters?|timestamps?|"
    r"订阅|关注|赞助|加入.*群|商务合作|章节|时间戳)\b",
    re.IGNORECASE,
)
MIN_MEANINGFUL_CHARACTERS = 40


def clean_source_text(value: str) -> str:
    retained: list[str] = []
    for raw_line in value.splitlines():
        line = SPACE_RE.sub(" ", raw_line).strip(" -\t")
        promotion_candidate = re.sub(r"^[^\w\u4e00-\u9fff]+", "", line)
        if not line or URL_RE.fullmatch(line) or PROMOTIONAL_LINE_RE.match(promotion_candidate):
            continue
        retained.append(line)
    return "\n".join(retained).strip()


def source_text_status(value: str) -> tuple[str, str, str]:
    cleaned = clean_source_text(value)
    url_characters = sum(len(match.group(0)) for match in URL_RE.finditer(cleaned))
    if cleaned and url_characters / len(cleaned) > 0.35:
        return "unavailable", "", "来源简介以链接或推广信息为主"
    meaningful = re.sub(r"[^\w\u4e00-\u9fff]", "", URL_RE.sub("", cleaned))
    if len(meaningful) < MIN_MEANINGFUL_CHARACTERS:
        return "unavailable", "", "来源未提供足够的可用简介"
    return "available", cleaned, ""
