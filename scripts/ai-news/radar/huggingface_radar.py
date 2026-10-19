"""Collect newly published models from allowlisted Hugging Face organizations."""

from __future__ import annotations

import gzip
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, TypedDict

from .models import ContentItem, SourceCheck, SourceHealth
from .storage import Storage

HUGGINGFACE_MODELS_API = "https://huggingface.co/api/models"
FETCH_TIMEOUT_SECONDS = 20
CACHE_FALLBACK_HOURS = 36
LOCAL_CACHE_REUSE_MINUTES = 15


class HuggingFaceRadarConfig(TypedDict):
    organizations: list[str]
    max_candidates_per_organization: int
    max_items: int


def load_huggingface_radar_config(path: Path) -> HuggingFaceRadarConfig:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Hugging Face radar config is unavailable: {error}") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("Hugging Face radar config requires schema_version 1")
    organizations = payload.get("organizations")
    per_org = payload.get("max_candidates_per_organization", 5)
    max_items = payload.get("max_items", 12)
    if (
        not isinstance(organizations, list)
        or not organizations
        or any(not isinstance(value, str) or not value.strip() for value in organizations)
    ):
        raise ValueError("Hugging Face organizations are invalid")
    normalized = list(dict.fromkeys(value.strip() for value in organizations))
    if not isinstance(per_org, int) or isinstance(per_org, bool) or not 1 <= per_org <= 20:
        raise ValueError("Hugging Face candidate limit must be 1 through 20")
    if not isinstance(max_items, int) or isinstance(max_items, bool) or not 1 <= max_items <= 30:
        raise ValueError("Hugging Face max_items must be 1 through 30")
    return {
        "organizations": normalized,
        "max_candidates_per_organization": per_org,
        "max_items": max_items,
    }


def _cache_recent(cache: dict[str, object]) -> bool:
    try:
        fetched = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return False
    return datetime.now(timezone.utc) - fetched <= timedelta(hours=CACHE_FALLBACK_HOURS)


def _cache_hot(cache: dict[str, object]) -> bool:
    try:
        fetched = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return False
    return datetime.now(timezone.utc) - fetched <= timedelta(minutes=LOCAL_CACHE_REUSE_MINUTES)


def _fetch_json(url: str, storage: Storage) -> tuple[object, bool]:
    cache = storage.get_http_cache(url)
    if cache and _cache_hot(cache):
        return json.loads(bytes(cache["body"])), True
    headers = {"Accept": "application/json", "User-Agent": "ai-news-skills/2.0"}
    token = os.environ.get("AI_NEWS_HUGGINGFACE_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            body = response.read()
            if response.headers.get("Content-Encoding", "").casefold() == "gzip":
                body = gzip.decompress(body)
            storage.put_http_cache(url, body, response.headers.get("ETag", ""), "")
            return json.loads(body), False
    except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        if cache and _cache_recent(cache):
            return json.loads(bytes(cache["body"])), True
        raise


def _timestamp(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_huggingface_models(
    config: HuggingFaceRadarConfig,
    cutoff: datetime,
    storage: Storage,
    fetcher: Callable[[str, Storage], tuple[object, bool]] = _fetch_json,
) -> tuple[list[ContentItem], SourceHealth]:
    items: list[ContentItem] = []
    checks: list[SourceCheck] = []

    def collect_organization(
        organization: str,
    ) -> tuple[list[ContentItem], SourceCheck, int]:
        query = urllib.parse.urlencode(
            {
                "author": organization,
                "sort": "createdAt",
                "direction": "-1",
                "limit": str(config["max_candidates_per_organization"]),
                "full": "true",
            }
        )
        try:
            payload, cached = fetcher(f"{HUGGINGFACE_MODELS_API}?{query}", storage)
            if not isinstance(payload, list):
                raise ValueError("Hugging Face response is not an array")
            organization_items: list[ContentItem] = []
            for model in payload:
                if not isinstance(model, dict):
                    continue
                model_id = str(model.get("id", "")).strip()
                created_at = _timestamp(model.get("createdAt"))
                if created_at < cutoff or not model_id.startswith(f"{organization}/"):
                    continue
                pipeline = str(model.get("pipeline_tag") or "未标注任务").strip()
                library = str(model.get("library_name") or "未标注框架").strip()
                tags = [str(tag) for tag in model.get("tags", []) if isinstance(tag, str)]
                license_tag = next(
                    (tag.removeprefix("license:") for tag in tags if tag.startswith("license:")),
                    "未标注许可证",
                )
                downloads = int(model.get("downloads") or 0)
                likes = int(model.get("likes") or 0)
                raw_text = (
                    f"Hugging Face Hub metadata reports that {organization} published {model_id} "
                    f"at {created_at.isoformat()}. Pipeline: {pipeline}; library: {library}; "
                    f"license tag: {license_tag}; observed downloads: {downloads}; observed likes: {likes}. "
                    "This is uploader-controlled repository metadata and platform activity, not an independent quality review."
                )
                organization_items.append(
                    ContentItem(
                        item_id=model_id,
                        source_type="model_hub",
                        source=f"Hugging Face · {organization}",
                        title=f"{organization} 发布模型 {model_id.split('/', 1)[-1]}",
                        published_at=created_at,
                        url=f"https://huggingface.co/{urllib.parse.quote(model_id, safe='/')}",
                        raw_source_text=raw_text,
                        extra="Hugging Face Hub metadata",
                    )
                )
            return (
                organization_items,
                SourceCheck(organization, "ok", len(organization_items), int(cached), "new models"),
                int(cached),
            )
        except Exception as error:
            return [], SourceCheck(organization, "error", 0, 0, type(error).__name__), 0

    cached_count = 0
    with ThreadPoolExecutor(max_workers=min(6, len(config["organizations"]))) as executor:
        futures = {
            executor.submit(collect_organization, organization): organization
            for organization in config["organizations"]
        }
        for future in as_completed(futures):
            organization_items, check, cached = future.result()
            items.extend(organization_items)
            checks.append(check)
            cached_count += cached
    checks.sort(key=lambda check: check.name.casefold())
    failed = sum(check.status == "error" for check in checks)
    unique = {item.item_id: item for item in items}
    ordered = sorted(unique.values(), key=lambda item: item.published_at, reverse=True)[
        : config["max_items"]
    ]
    fetched = len(checks) - failed
    status = "error" if not fetched else "warn" if failed else "ok"
    return ordered, SourceHealth(
        "model_hub",
        status,
        fetched,
        failed,
        cached_count,
        f"{len(config['organizations'])} organizations; {len(ordered)} new models; {failed} failures",
        tuple(checks),
    )
