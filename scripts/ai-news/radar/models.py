"""Shared immutable runtime models."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .url_utils import canonical_url


@dataclass(frozen=True, slots=True)
class ContentItem:
    item_id: str
    source_type: str
    source: str
    title: str
    published_at: datetime
    url: str
    raw_source_text: str = ""
    recommendation: str = ""
    extra: str = ""

    @property
    def key(self) -> str:
        return f"{self.source_type}:{self.item_id}"

    @property
    def dedup_identity(self) -> str:
        normalized = canonical_url(self.url)
        if self.source_type == "github_trending":
            return normalized
        if self.source_type == "security_advisory":
            return f"{normalized}#advisory-date={self.published_at.date().isoformat()}"
        if self.extra == "官方 Release Notes":
            return f"{normalized}#entry={self.item_id}"
        if self.extra == "官方 Changelog":
            return f"{normalized}#date={self.published_at.date().isoformat()}"
        return normalized


@dataclass(frozen=True, slots=True)
class SourceCheck:
    name: str
    status: str
    items: int
    cached: int = 0
    detail: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "status": self.status,
            "items": self.items,
            "cached": self.cached,
            "detail": self.detail,
        }


@dataclass(frozen=True, slots=True)
class SourceHealth:
    source: str
    status: str
    fetched: int
    failed: int
    cached: int
    detail: str = ""
    checks: tuple[SourceCheck, ...] = ()

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "source": self.source,
            "status": self.status,
            "fetched": self.fetched,
            "failed": self.failed,
            "cached": self.cached,
            "detail": self.detail,
        }
        if self.checks:
            payload["checks"] = [check.to_dict() for check in self.checks]
        return payload
