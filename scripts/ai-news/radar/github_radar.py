"""Discover AI projects from GitHub's official daily Trending page."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, TypedDict
from zoneinfo import ZoneInfo

from .models import ContentItem, SourceCheck, SourceHealth
from .storage import Storage

GITHUB_TRENDING_URL = "https://github.com/trending?since=daily"
GITHUB_REPOSITORY_API = "https://api.github.com/repos/{repository}"
GITHUB_API_VERSION = "2022-11-28"
FETCH_TIMEOUT_SECONDS = 20
LOCAL_CACHE_REUSE_MINUTES = 30
TRENDING_CACHE_FALLBACK_HOURS = 12
REPOSITORY_CACHE_FALLBACK_HOURS = 36
SHANGHAI = ZoneInfo("Asia/Shanghai")


class GitHubRateLimitError(RuntimeError):
    """Stop repository API calls after GitHub signals a rate limit."""


class GitHubRadarConfig(TypedDict):
    period: str
    max_candidates: int
    max_items: int
    ai_topics: list[str]
    ai_keywords: list[str]


class GitHubPageFetchResult(TypedDict):
    body: bytes
    cache_mode: str


class GitHubFetchResult(TypedDict):
    payload: dict[str, object]
    cache_mode: str


GitHubPageFetcher = Callable[[str, Storage], GitHubPageFetchResult]
GitHubRepositoryFetcher = Callable[[str, Storage], GitHubFetchResult]


def load_github_radar_config(path: Path) -> GitHubRadarConfig:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid GitHub radar configuration: {error}") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != 2:
        raise ValueError("GitHub radar configuration requires schema_version 2")
    if payload.get("period") != "daily":
        raise ValueError("GitHub radar period must be daily")

    validated: dict[str, object] = {"period": "daily"}
    for field, minimum, maximum in (
        ("max_candidates", 1, 50),
        ("max_items", 1, 25),
    ):
        value = payload.get(field)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not minimum <= value <= maximum
        ):
            raise ValueError(f"GitHub radar {field} must be between {minimum} and {maximum}")
        validated[field] = value
    if int(validated["max_items"]) > int(validated["max_candidates"]):
        raise ValueError("GitHub radar max_items must not exceed max_candidates")

    for field, maximum_items, maximum_length in (
        ("ai_topics", 40, 60),
        ("ai_keywords", 60, 80),
    ):
        values = payload.get(field)
        if not isinstance(values, list) or not 1 <= len(values) <= maximum_items:
            raise ValueError(
                f"GitHub radar {field} must contain one through {maximum_items} entries"
            )
        normalized: list[str] = []
        for value in values:
            if not isinstance(value, str):
                raise ValueError(f"GitHub radar {field} entries must be strings")
            text = " ".join(value.strip().casefold().split())
            if not text or len(text) > maximum_length:
                raise ValueError(f"GitHub radar {field} contains an invalid entry")
            if text not in normalized:
                normalized.append(text)
        validated[field] = normalized
    return GitHubRadarConfig(**validated)  # type: ignore[arg-type]


def _cache_age(cache: dict[str, object]) -> timedelta | None:
    try:
        fetched_at = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return None
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - fetched_at


def _cache_body(cache: dict[str, object]) -> bytes:
    body = cache.get("body", b"")
    if not isinstance(body, (bytes, bytearray, memoryview)):
        raise ValueError("GitHub cache body is invalid")
    return bytes(body)


def _same_shanghai_day(cache: dict[str, object]) -> bool:
    try:
        fetched_at = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return False
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    return fetched_at.astimezone(SHANGHAI).date() == datetime.now(SHANGHAI).date()


def _request_headers(*, html: bool) -> dict[str, str]:
    headers = {
        "Accept": "text/html" if html else "application/vnd.github+json",
        "User-Agent": "ai-news-skills/1.0",
    }
    if not html:
        headers["X-GitHub-Api-Version"] = GITHUB_API_VERSION
        token = os.environ.get("AI_NEWS_GITHUB_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


def _fetch_trending_html(url: str, storage: Storage) -> GitHubPageFetchResult:
    cache = storage.get_http_cache(url)
    age = _cache_age(cache) if cache else None
    if cache and age is not None and age <= timedelta(minutes=LOCAL_CACHE_REUSE_MINUTES):
        return {"body": _cache_body(cache), "cache_mode": "local_reuse"}
    headers = _request_headers(html=True)
    if cache and cache.get("etag"):
        headers["If-None-Match"] = str(cache["etag"])
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            body = response.read()
            storage.put_http_cache(url, body, response.headers.get("ETag", ""), "")
            return {"body": body, "cache_mode": "fresh"}
    except urllib.error.HTTPError as error:
        if error.code == 304 and cache:
            return {"body": _cache_body(cache), "cache_mode": "revalidated"}
        fallback = error.code in {403, 408, 429, 500, 502, 503, 504}
        can_fallback = (
            cache
            and fallback
            and age is not None
            and age <= timedelta(hours=TRENDING_CACHE_FALLBACK_HOURS)
            and _same_shanghai_day(cache)
        )
        if can_fallback:
            return {"body": _cache_body(cache), "cache_mode": "stale_fallback"}
        raise
    except (OSError, TimeoutError, urllib.error.URLError):
        can_fallback = (
            cache
            and age is not None
            and age <= timedelta(hours=TRENDING_CACHE_FALLBACK_HOURS)
            and _same_shanghai_day(cache)
        )
        if can_fallback:
            return {"body": _cache_body(cache), "cache_mode": "stale_fallback"}
        raise


def _fetch_github_json(url: str, storage: Storage) -> GitHubFetchResult:
    cache = storage.get_http_cache(url)
    age = _cache_age(cache) if cache else None
    if cache and age is not None and age <= timedelta(minutes=LOCAL_CACHE_REUSE_MINUTES):
        payload = json.loads(_cache_body(cache).decode("utf-8"))
        return {"payload": payload, "cache_mode": "local_reuse"}
    headers = _request_headers(html=False)
    if cache and cache.get("etag"):
        headers["If-None-Match"] = str(cache["etag"])
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            body = response.read()
            payload = json.loads(body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("GitHub repository response must be an object")
            storage.put_http_cache(url, body, response.headers.get("ETag", ""), "")
            return {"payload": payload, "cache_mode": "fresh"}
    except urllib.error.HTTPError as error:
        if error.code == 304 and cache:
            payload = json.loads(_cache_body(cache).decode("utf-8"))
            return {"payload": payload, "cache_mode": "revalidated"}
        fallback = error.code in {403, 408, 429, 500, 502, 503, 504}
        if (
            cache
            and fallback
            and age is not None
            and age <= timedelta(hours=REPOSITORY_CACHE_FALLBACK_HOURS)
        ):
            payload = json.loads(_cache_body(cache).decode("utf-8"))
            return {"payload": payload, "cache_mode": "stale_fallback"}
        if error.code in {403, 429}:
            raise GitHubRateLimitError("GitHub repository API rate limited") from error
        raise
    except (OSError, TimeoutError, urllib.error.URLError):
        if cache and age is not None and age <= timedelta(hours=REPOSITORY_CACHE_FALLBACK_HOURS):
            payload = json.loads(_cache_body(cache).decode("utf-8"))
            return {"payload": payload, "cache_mode": "stale_fallback"}
        raise


def _attributes(values: list[tuple[str, str | None]]) -> dict[str, str]:
    return {name: value or "" for name, value in values}


def _number(value: str) -> int:
    match = re.search(r"\d[\d,]*", value)
    return int(match.group(0).replace(",", "")) if match else 0


class _TrendingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.records: list[dict[str, object]] = []
        self.current: dict[str, object] | None = None
        self.in_repository_heading = False
        self.capture_field = ""
        self.capture_tag = ""
        self.capture_same_tag_depth = 0
        self.capture_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = _attributes(attrs)
        classes = set(attributes.get("class", "").split())
        if self.current is None:
            if tag == "article" and "Box-row" in classes:
                self.current = {"rank": len(self.records) + 1}
            return
        if self.capture_field:
            if tag == self.capture_tag:
                self.capture_same_tag_depth += 1
            return
        if tag == "h2":
            self.in_repository_heading = True
        href = attributes.get("href", "")
        path = [part for part in href.split("?")[0].split("/") if part]
        if (
            tag == "a"
            and self.in_repository_heading
            and len(path) == 2
            and not self.current.get("full_name")
        ):
            self.current["full_name"] = "/".join(path)
            self.current["url"] = f"https://github.com/{'/'.join(path)}"
        if tag == "p" and {"col-9", "color-fg-muted"}.issubset(classes):
            self._start_capture("description", tag)
        elif tag == "a" and href.endswith("/stargazers"):
            self._start_capture("total_stars", tag)
        elif tag == "span" and {"d-inline-block", "float-sm-right"}.issubset(classes):
            self._start_capture("daily_stars", tag)

    def _start_capture(self, field: str, tag: str) -> None:
        self.capture_field = field
        self.capture_tag = tag
        self.capture_same_tag_depth = 1
        self.capture_text = []

    def handle_data(self, data: str) -> None:
        if self.capture_field:
            self.capture_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.current is None:
            return
        if self.capture_field and tag == self.capture_tag:
            self.capture_same_tag_depth -= 1
            if self.capture_same_tag_depth == 0:
                text = " ".join("".join(self.capture_text).split())
                if self.capture_field in {"total_stars", "daily_stars"}:
                    self.current[self.capture_field] = _number(text)
                else:
                    self.current[self.capture_field] = text
                self.capture_field = ""
                self.capture_tag = ""
                self.capture_text = []
        if tag == "h2":
            self.in_repository_heading = False
        if tag == "article":
            if self.current.get("full_name") and self.current.get("url"):
                self.records.append(self.current)
            self.current = None
            self.in_repository_heading = False


def parse_trending_html(body: bytes) -> list[dict[str, object]]:
    parser = _TrendingParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    if not parser.records:
        raise ValueError("GitHub Trending page contains no repository rows")
    return parser.records


def _metadata(payload: dict[str, object]) -> dict[str, object]:
    topics = payload.get("topics", [])
    normalized_topics = (
        [
            str(value).strip().casefold()
            for value in topics
            if isinstance(value, str) and value.strip()
        ]
        if isinstance(topics, list)
        else []
    )
    metadata: dict[str, object] = {
        "total_stars": max(0, int(payload.get("stargazers_count", 0))),
        "topics": normalized_topics,
        "archived": bool(payload.get("archived")),
        "fork": bool(payload.get("fork")),
    }
    description = " ".join(str(payload.get("description") or "").split())
    if description:
        metadata["description"] = description
    return metadata


def _contains_keyword(text: str, keyword: str) -> bool:
    pattern = r"(?<![a-z0-9])" + re.escape(keyword).replace(r"\ ", r"\s+") + r"(?![a-z0-9])"
    return re.search(pattern, text, re.IGNORECASE) is not None


def _is_ai_project(candidate: dict[str, object], config: GitHubRadarConfig) -> bool:
    topics = {str(value).casefold() for value in candidate.get("topics", [])}
    if topics.intersection(config["ai_topics"]):
        return True
    text = " ".join(
        (
            str(candidate.get("full_name", "")),
            str(candidate.get("description", "")),
        )
    ).casefold()
    return any(_contains_keyword(text, keyword) for keyword in config["ai_keywords"])


def _source_text(candidate: dict[str, object]) -> str:
    description = " ".join(str(candidate["description"]).split())
    stars = int(candidate["total_stars"])
    return (
        f"The repository owner describes {candidate['full_name']} as follows: {description}\n"
        f"GitHub reports {stars:,} total Stars for this public repository."
    )


def fetch_github_trending(
    config: GitHubRadarConfig,
    storage: Storage,
    observed_at: datetime | None = None,
    page_fetcher: GitHubPageFetcher = _fetch_trending_html,
    repository_fetcher: GitHubRepositoryFetcher = _fetch_github_json,
) -> tuple[list[ContentItem], SourceHealth]:
    observed_at = (observed_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        page_result = page_fetcher(GITHUB_TRENDING_URL, storage)
        records = parse_trending_html(page_result["body"])
    except Exception as error:
        detail = (
            f"HTTP {error.code}"
            if isinstance(error, urllib.error.HTTPError)
            else str(error)[:160] or type(error).__name__
        )
        return [], SourceHealth(
            "github_trending", "error", 0, 1, 0, detail,
            (SourceCheck("trending-page", "error", 0, 0, detail),),
        )

    candidates = records[: config["max_candidates"]]
    accepted: list[ContentItem] = []
    metadata_failures = 0
    metadata_successes = 0
    inspected = 0
    already_seen = 0
    metadata_enabled = True
    rate_limited = False
    cached = int(page_result["cache_mode"] != "fresh")
    stale = int(page_result["cache_mode"] == "stale_fallback")
    for record in candidates:
        inspected += 1
        full_name = str(record["full_name"])
        candidate = dict(record)
        if storage.has_seen_github_repository(str(candidate["url"])):
            already_seen += 1
            continue
        if metadata_enabled:
            try:
                repository_url = GITHUB_REPOSITORY_API.format(
                    repository=urllib.parse.quote(full_name, safe="/")
                )
                repository_result = repository_fetcher(repository_url, storage)
                candidate.update(_metadata(repository_result["payload"]))
                metadata_successes += 1
                cached += int(repository_result["cache_mode"] != "fresh")
                stale += int(repository_result["cache_mode"] == "stale_fallback")
            except GitHubRateLimitError:
                metadata_failures += 1
                metadata_enabled = False
                rate_limited = True
                candidate.setdefault("topics", [])
            except Exception:
                metadata_failures += 1
                candidate.setdefault("topics", [])
        else:
            metadata_failures += 1
            candidate.setdefault("topics", [])
        if candidate.get("archived") or candidate.get("fork"):
            continue
        description = " ".join(str(candidate.get("description") or "").split())
        total_stars = max(0, int(candidate.get("total_stars", 0)))
        if len(description) < 24 or total_stars <= 0:
            continue
        candidate["description"] = description
        candidate["total_stars"] = total_stars
        if not _is_ai_project(candidate, config):
            continue
        item_id = hashlib.sha256(
            f"{full_name.casefold()}:{observed_at.date().isoformat()}".encode("utf-8")
        ).hexdigest()[:24]
        accepted.append(
            ContentItem(
                item_id=item_id,
                source_type="github_trending",
                source="GitHub 开源雷达 · GitHub Trending",
                title=full_name,
                published_at=observed_at,
                url=str(candidate["url"]),
                raw_source_text=_source_text(candidate),
                extra="GitHub Trending",
            )
        )
        if len(accepted) >= config["max_items"]:
            break

    page_mode = page_result["cache_mode"]
    status = (
        "warn"
        if metadata_failures or stale or page_mode == "stale_fallback"
        else "ok"
    )
    checks = (
        SourceCheck(
            "trending-page",
            "warn" if page_mode == "stale_fallback" else "ok",
            len(records),
            int(page_mode != "fresh"),
            page_mode,
        ),
        SourceCheck(
            "repository-metadata",
            "warn" if metadata_failures or stale else "ok",
            metadata_successes,
            cached - int(page_mode != "fresh"),
            (
                f"{metadata_failures} failures; {stale} stale fallbacks; "
                f"{already_seen} previously reported; rate_limited={str(rate_limited).lower()}"
            ),
        ),
    )
    detail = (
        f"{len(records)} daily Trending repositories; {inspected} inspected; "
        f"{len(accepted)} new AI projects; {already_seen} previously reported; "
        f"{metadata_failures} metadata failures"
    )
    return accepted, SourceHealth(
        "github_trending",
        status,
        1 + metadata_successes,
        metadata_failures, cached, detail, checks,
    )
