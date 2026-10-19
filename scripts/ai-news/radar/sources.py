"""Fetch official news, editorial digests, video channels, AIHOT, and Builders X."""

from __future__ import annotations

import gzip
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable
from xml.etree import ElementTree as ET

from .models import ContentItem, SourceHealth
from .official_news import OfficialSource, fetch_official_news
from .github_radar import GitHubRadarConfig, fetch_github_trending
from .huggingface_radar import HuggingFaceRadarConfig, fetch_huggingface_models
from .security_advisories import SecurityAdvisoryConfig, fetch_security_advisories
from .storage import Storage

USER_AGENT = "ai-news-skills/1.0"
FETCH_TIMEOUT_SECONDS = 20
CACHE_FALLBACK_HOURS = 72
LOCAL_CACHE_REUSE_MINUTES = 15
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
X_HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
AIHOT_API_URL = "https://aihot.virxact.com/api/public/items"
BUILDERS_X_FEED_URL = (
    "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json"
)
BUILDERS_X_MAX_FEED_AGE_HOURS = 36
BUILDERS_X_SNAPSHOT_HOURS = 24
BUILDERS_X_MIN_TEXT_LENGTH = 60
BUILDERS_X_TOPIC_RE = re.compile(
    r"(?:\b(?:ai|artificial intelligence|agentic|agents?|llms?|models?|inference|"
    r"training|benchmarks?|evals?|tokens?|multimodal|coding|codex|claude|anthropic|"
    r"openai|chatgpt|gemini|cursor|replit|vercel|prompts?|compute|open weights?|"
    r"foundation models?|neural|machine learning)\b|"
    r"人工智能|智能体|大模型|模型|推理|训练|评测|多模态|编程)",
    re.IGNORECASE,
)
YOUTUBE_TOPIC_RE = re.compile(
    BUILDERS_X_TOPIC_RE.pattern
    + r"|\b(?:autonomous|robotics?|gpu|vector databases?|physical ai)\b|"
    r"自动驾驶|机器人|向量数据库",
    re.IGNORECASE,
)
BUILDERS_X_SIGNAL_RE = re.compile(
    r"(?:\b(?:ai|artificial intelligence|agentic|agents?|llms?|models?|inference|"
    r"training|benchmarks?|evals?|tokens?|multimodal|coding|compute|open weights?|"
    r"foundation models?|neural|machine learning|research|paper|api|tools?|products?|"
    r"systems?|workflows?|releases?|released|launches?|launched|announces?|announced|"
    r"ships?|shipped|updates?|updated|enterprise|enterprises|price|pricing|costs?|"
    r"latency|speed|performance|adoption|developers?|dev stack)\b|"
    r"人工智能|智能体|大模型|模型|推理|训练|评测|多模态|编程|开源|发布|上线|研究)",
    re.IGNORECASE,
)
BUILDERS_X_PROMOTION_RE = re.compile(
    r"\b(?:we(?:'re| are) hiring|hiring (?:a|an|for)|apply (?:now|here)|"
    r"job openings?|join (?:our|the) team|reply or dm|dm me|tell me why)\b",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def load_channels(path: Path) -> list[dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"channel file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"channel file is invalid JSON: {error}") from error
    if not isinstance(value, list) or not value:
        raise ValueError("channel file must contain a non-empty array")
    channels: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, entry in enumerate(value, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"channel {index} must be an object")
        name = str(entry.get("name", "")).strip()
        channel_id = str(entry.get("channel_id", "")).strip()
        if not name or not CHANNEL_ID_RE.fullmatch(channel_id):
            raise ValueError(f"channel {index} has invalid name or channel_id")
        if channel_id in seen:
            raise ValueError(f"duplicate channel_id at channel {index}")
        seen.add(channel_id)
        channels.append({"name": name, "channel_id": channel_id})
    return channels


def load_builders_x_accounts(path: Path) -> list[dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Builders X account file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Builders X account file is invalid JSON: {error}") from error
    if not isinstance(value, list) or not value:
        raise ValueError("Builders X account file must contain a non-empty array")
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, entry in enumerate(value, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"Builders X account {index} must be an object")
        name = str(entry.get("name", "")).strip()
        handle = str(entry.get("handle", "")).strip().lstrip("@")
        normalized = handle.casefold()
        if not name or not X_HANDLE_RE.fullmatch(handle):
            raise ValueError(f"Builders X account {index} has invalid name or handle")
        if normalized in seen:
            raise ValueError(f"duplicate Builders X handle at account {index}")
        seen.add(normalized)
        accounts.append({"name": name, "handle": handle})
    return accounts


def _cache_is_recent(cache: dict[str, object]) -> bool:
    try:
        fetched = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return False
    return datetime.now(timezone.utc) - fetched <= timedelta(hours=CACHE_FALLBACK_HOURS)


def _cache_is_hot(cache: dict[str, object]) -> bool:
    try:
        fetched = datetime.fromisoformat(str(cache["fetched_at"]))
    except (KeyError, ValueError):
        return False
    return datetime.now(timezone.utc) - fetched <= timedelta(minutes=LOCAL_CACHE_REUSE_MINUTES)


def _cached_body(cache: dict[str, object]) -> bytes:
    body = cache.get("body")
    if isinstance(body, bytes):
        return body
    if isinstance(body, (bytearray, memoryview)):
        return bytes(body)
    raise ValueError("cached response body is not binary")


def _fetch_bytes(url: str, storage: Storage) -> tuple[bytes, bool]:
    cache = storage.get_http_cache(url)
    if cache and _cache_is_hot(cache):
        return _cached_body(cache), True
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json, application/atom+xml, */*"}
    if cache:
        if cache.get("etag"):
            headers["If-None-Match"] = str(cache["etag"])
        if cache.get("last_modified"):
            headers["If-Modified-Since"] = str(cache["last_modified"])
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            body = response.read()
            if response.headers.get("Content-Encoding", "").casefold() == "gzip":
                body = gzip.decompress(body)
            storage.put_http_cache(
                url,
                body,
                response.headers.get("ETag", ""),
                response.headers.get("Last-Modified", ""),
            )
            return body, False
    except urllib.error.HTTPError as error:
        if error.code == 304 and cache:
            return _cached_body(cache), True
        if cache and _cache_is_recent(cache) and error.code in {408, 429, 500, 502, 503, 504}:
            return _cached_body(cache), True
        raise
    except (OSError, TimeoutError, urllib.error.URLError):
        if cache and _cache_is_recent(cache):
            return _cached_body(cache), True
        raise


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _fetch_youtube_channel(
    channel: dict[str, str],
    cutoff: datetime,
    storage: Storage,
    fetcher: Callable[[str, Storage], tuple[bytes, bool]] = _fetch_bytes,
) -> tuple[list[ContentItem], bool, int]:
    url = (
        "https://www.youtube.com/feeds/videos.xml?channel_id="
        + urllib.parse.quote(channel["channel_id"])
    )
    body, cached = fetcher(url, storage)
    root = ET.fromstring(body)
    items: list[ContentItem] = []
    filtered_off_topic = 0
    for entry in root.findall("atom:entry", NS):
        item_id = entry.findtext("yt:videoId", default="", namespaces=NS).strip()
        published_text = entry.findtext("atom:published", default="", namespaces=NS).strip()
        if not item_id or not published_text:
            continue
        published_at = _parse_datetime(published_text)
        if published_at < cutoff:
            continue
        link = entry.find("atom:link", NS)
        title = entry.findtext("atom:title", default="", namespaces=NS).strip()
        description = entry.findtext(
            "media:group/media:description", default="", namespaces=NS
        ).strip()
        if not YOUTUBE_TOPIC_RE.search(f"{title}\n{description}"):
            filtered_off_topic += 1
            continue
        items.append(
            ContentItem(
                item_id=item_id,
                source_type="youtube",
                source=f"YouTube · {channel['name']}",
                title=title,
                published_at=published_at,
                url=link.get("href", "") if link is not None else "",
                raw_source_text=description,
            )
        )
    return items, cached, filtered_off_topic


def fetch_youtube(
    channels: list[dict[str, str]],
    cutoff: datetime,
    storage: Storage,
    fetcher: Callable[[str, Storage], tuple[bytes, bool]] = _fetch_bytes,
) -> tuple[list[ContentItem], SourceHealth]:
    items: list[ContentItem] = []
    failed = 0
    cached = 0
    channels_with_items = 0
    filtered_off_topic = 0
    failed_channels: list[str] = []
    workers = min(6, len(channels))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                _fetch_youtube_channel, channel, cutoff, storage, fetcher
            ): channel
            for channel in channels
        }
        for future in as_completed(futures):
            try:
                channel_items, used_cache, channel_filtered = future.result()
            except Exception:
                failed += 1
                failed_channels.append(futures[future]["name"])
                continue
            items.extend(channel_items)
            cached += int(used_cache)
            filtered_off_topic += channel_filtered
            channels_with_items += int(bool(channel_items))
    status = "error" if failed == len(channels) else "partial" if failed else "ok"
    fetched = len(channels) - failed
    detail = (
        f"{len(channels)} configured channels; {fetched} fetched; "
        f"{channels_with_items} with relevant in-window items; "
        f"{fetched - channels_with_items} without relevant in-window items; "
        f"{filtered_off_topic} off-topic items filtered"
    )
    if failed_channels:
        detail += f"; unavailable: {', '.join(sorted(failed_channels))}"
    health = SourceHealth(
        source="youtube",
        status=status,
        fetched=fetched,
        failed=failed,
        cached=cached,
        detail=detail,
    )
    return items, health


def fetch_aihot(cutoff: datetime, storage: Storage) -> tuple[list[ContentItem], SourceHealth]:
    since = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"{AIHOT_API_URL}?{urllib.parse.urlencode({'mode': 'selected', 'since': since})}"
    try:
        body, cached = _fetch_bytes(url, storage)
        payload = json.loads(body.decode("utf-8"))
        entries = payload.get("items", [])
        if not isinstance(entries, list):
            raise ValueError("AIHOT items is not an array")
    except Exception:
        return [], SourceHealth("aihot", "error", 0, 1, 0, "official API unavailable")

    items: list[ContentItem] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("id", "")).strip()
        published_text = str(entry.get("publishedAt", "")).strip()
        if not item_id or not published_text:
            continue
        try:
            published_at = _parse_datetime(published_text)
        except ValueError:
            continue
        if published_at < cutoff:
            continue
        score = entry.get("score", "")
        category = str(entry.get("category", "")).strip()
        recommendation = str(
            entry.get("aiSelectedReason")
            or entry.get("selectionReason")
            or entry.get("reason")
            or ""
        ).strip()
        items.append(
            ContentItem(
                item_id=item_id,
                source_type="aihot",
                source=f"AIHOT · {entry.get('source') or '精选'}",
                title=str(entry.get("title") or "").strip(),
                published_at=published_at,
                url=str(entry.get("url") or entry.get("permalink") or "").strip(),
                raw_source_text=str(entry.get("summary") or "").strip(),
                recommendation=recommendation,
                extra=f"精选分 {score} · {category}" if score else category,
            )
        )
    return items, SourceHealth("aihot", "ok", 1, 0, int(cached), "official selected-items API")


def fetch_industry_digests(
    sources: list[OfficialSource],
    cutoff: datetime,
    storage: Storage,
    fetcher: Callable[[str, Storage], tuple[bytes, bool]] = _fetch_bytes,
) -> tuple[list[ContentItem], SourceHealth]:
    items, health = fetch_official_news(sources, cutoff, storage, fetcher)
    adapted = [
        replace(
            item,
            source_type="industry_digest",
            source=f"行业精选 · {item.source.split('·', 1)[-1].strip()}",
            extra=item.extra.replace("官方 RSS", "编辑 RSS"),
        )
        for item in items
    ]
    return adapted, replace(
        health,
        source="industry_digest",
        detail=health.detail.replace(
            "configured sources",
            "configured editorial feeds",
        ),
    )


def _clean_x_text(value: str) -> str:
    without_urls = URL_RE.sub("", value)
    return re.sub(r"\s+", " ", without_urls).strip()


def _safe_count(value: object) -> int:
    try:
        return max(0, int(str(value or 0)))
    except ValueError:
        return 0


def parse_builders_x(
    payload: object,
    accounts: list[dict[str, str]],
    cutoff: datetime,
    now: datetime,
) -> tuple[list[ContentItem], dict[str, int]]:
    """Parse untrusted feed data against the repository-owned account allowlist."""
    if not isinstance(payload, dict):
        raise ValueError("Builders X feed must be an object")
    generated_text = str(payload.get("generatedAt", "")).strip()
    try:
        generated_at = _parse_datetime(generated_text)
    except ValueError as error:
        raise ValueError("Builders X feed has an invalid generatedAt") from error
    if generated_at > now + timedelta(minutes=15):
        raise ValueError("Builders X feed timestamp is in the future")
    if now - generated_at > timedelta(hours=BUILDERS_X_MAX_FEED_AGE_HOURS):
        raise ValueError("Builders X feed is stale")

    entries = payload.get("x")
    if not isinstance(entries, list):
        raise ValueError("Builders X feed x field must be an array")
    allowlist = {account["handle"].casefold(): account for account in accounts}
    snapshot_cutoff = generated_at - timedelta(hours=BUILDERS_X_SNAPSHOT_HOURS)
    oldest_allowed = cutoff - timedelta(hours=BUILDERS_X_MAX_FEED_AGE_HOURS)
    snapshot_cutoff = max(snapshot_cutoff, oldest_allowed)
    stats = {
        "posts": 0,
        "accepted": 0,
        "filtered": 0,
        "unknown_accounts": 0,
        "invalid": 0,
        "outside_snapshot": 0,
        "too_short": 0,
        "no_ai_topic": 0,
        "no_signal": 0,
        "promotion": 0,
    }
    items: list[ContentItem] = []
    for account_entry in entries:
        if not isinstance(account_entry, dict):
            continue
        handle = str(account_entry.get("handle", "")).strip().lstrip("@")
        local_account = allowlist.get(handle.casefold())
        if not local_account:
            stats["unknown_accounts"] += 1
            continue
        tweets = account_entry.get("tweets")
        if not isinstance(tweets, list):
            continue
        for tweet in tweets:
            stats["posts"] += 1
            if not isinstance(tweet, dict):
                stats["filtered"] += 1
                continue
            item_id = str(tweet.get("id", "")).strip()
            created_text = str(tweet.get("createdAt", "")).strip()
            url = str(tweet.get("url", "")).strip()
            text = _clean_x_text(str(tweet.get("text", "")))
            try:
                published_at = _parse_datetime(created_text)
            except ValueError:
                stats["filtered"] += 1
                continue
            parsed_url = urllib.parse.urlparse(url)
            path_parts = [part for part in parsed_url.path.split("/") if part]
            valid_url = (
                parsed_url.scheme == "https"
                and parsed_url.netloc.casefold() in {"x.com", "www.x.com"}
                and len(path_parts) == 3
                and path_parts[0].casefold() == handle.casefold()
                and path_parts[1].casefold() == "status"
                and path_parts[2] == item_id
            )
            reason = ""
            if not item_id.isdigit() or not valid_url:
                reason = "invalid"
            elif not (
                snapshot_cutoff
                <= published_at
                <= generated_at + timedelta(minutes=5)
            ):
                reason = "outside_snapshot"
            elif len(text) < BUILDERS_X_MIN_TEXT_LENGTH:
                reason = "too_short"
            elif not BUILDERS_X_TOPIC_RE.search(text):
                reason = "no_ai_topic"
            elif not BUILDERS_X_SIGNAL_RE.search(text):
                reason = "no_signal"
            elif BUILDERS_X_PROMOTION_RE.search(text):
                reason = "promotion"
            if reason:
                stats["filtered"] += 1
                stats[reason] += 1
                continue
            title_text = text if len(text) <= 72 else f"{text[:69].rstrip()}..."
            engagement = (
                f"likes {_safe_count(tweet.get('likes'))} · "
                f"reposts {_safe_count(tweet.get('retweets'))} · "
                f"replies {_safe_count(tweet.get('replies'))}"
            )
            items.append(
                ContentItem(
                    item_id=item_id,
                    source_type="builders_x",
                    source=(
                        f"Builders X · {local_account['name']} "
                        f"(@{local_account['handle']})"
                    ),
                    title=f"{local_account['name']}：{title_text}",
                    published_at=published_at,
                    url=url,
                    raw_source_text=text,
                    extra=engagement,
                )
            )
            stats["accepted"] += 1
    return items, stats


def fetch_builders_x(
    accounts: list[dict[str, str]],
    cutoff: datetime,
    storage: Storage,
) -> tuple[list[ContentItem], SourceHealth]:
    try:
        body, cached = _fetch_bytes(BUILDERS_X_FEED_URL, storage)
        payload = json.loads(body.decode("utf-8"))
        items, stats = parse_builders_x(
            payload,
            accounts,
            cutoff,
            datetime.now(timezone.utc),
        )
    except Exception:
        return [], SourceHealth(
            "builders_x", "error", 0, 1, 0, "curated public feed unavailable"
        )
    generated_at = _parse_datetime(str(payload.get("generatedAt", "")))
    lag_hours = max(
        0.0,
        (datetime.now(timezone.utc) - generated_at).total_seconds() / 3600,
    )
    detail = (
        f"{len(accounts)} allowlisted accounts; {stats['posts']} posts checked; "
        f"{stats['accepted']} accepted; {stats['filtered']} filtered "
        f"(snapshot={stats['outside_snapshot']}, short={stats['too_short']}, "
        f"topic={stats['no_ai_topic']}, signal={stats['no_signal']}, "
        f"promotion={stats['promotion']}, invalid={stats['invalid']}); "
        f"snapshot lag {lag_hours:.1f}h"
    )
    return items, SourceHealth("builders_x", "ok", 1, 0, int(cached), detail)


def _deduplicate_items(items: list[ContentItem]) -> list[ContentItem]:
    unique: dict[str, ContentItem] = {}
    seen_urls: set[str] = set()
    seen_events: set[tuple[str, str, str]] = set()
    editorial_events: dict[str, list[tuple[str, str, str]]] = {}
    for item in items:
        if not item.item_id or not item.title or not item.url:
            continue
        url_key = item.dedup_identity
        if url_key in seen_urls:
            continue
        if item.source_type in {"official_news", "industry_digest"}:
            host = (urllib.parse.urlparse(item.url).hostname or "").casefold()
            host = host.removeprefix("www.")
            title_key = re.sub(
                r"[^a-z0-9\u4e00-\u9fff]+", " ", item.title.casefold()
            ).strip()
            date_key = item.published_at.date().isoformat()
            event_key = (host, date_key, title_key)
            if event_key in seen_events:
                continue
            duplicate_editorial_event = any(
                previous_host != host
                and (
                    previous_type == "industry_digest"
                    or item.source_type == "industry_digest"
                )
                and (
                    previous_title == title_key
                    or (
                        min(len(previous_title), len(title_key)) >= 24
                        and SequenceMatcher(
                            None, previous_title, title_key, autojunk=False
                        ).ratio()
                        >= 0.92
                    )
                )
                for previous_host, previous_title, previous_type in editorial_events.get(
                    date_key, []
                )
            )
            if duplicate_editorial_event:
                continue
            seen_events.add(event_key)
            editorial_events.setdefault(date_key, []).append(
                (host, title_key, item.source_type)
            )
        seen_urls.add(url_key)
        unique[item.key] = item
    return sorted(unique.values(), key=lambda item: item.published_at, reverse=True)


def collect_sources(
    channels: list[dict[str, str]],
    official_sources: list[OfficialSource],
    industry_digest_sources: list[OfficialSource],
    builders_x_accounts: list[dict[str, str]],
    github_radar_config: GitHubRadarConfig,
    security_advisory_config: SecurityAdvisoryConfig,
    huggingface_radar_config: HuggingFaceRadarConfig,
    cutoff: datetime,
    storage: Storage,
) -> tuple[list[ContentItem], list[SourceHealth]]:
    def timed_collect(collector: Callable[[], tuple[list[ContentItem], SourceHealth]]) -> tuple[list[ContentItem], SourceHealth]:
        started = time.monotonic()
        family_items, family_health = collector()
        elapsed_ms = round((time.monotonic() - started) * 1000)
        return family_items, replace(
            family_health,
            detail=f"{family_health.detail}; family_elapsed={elapsed_ms}ms",
        )

    collectors: dict[str, Callable[[], tuple[list[ContentItem], SourceHealth]]] = {
        "official_news": lambda: fetch_official_news(
            official_sources, cutoff, storage, _fetch_bytes
        ),
        "youtube": lambda: fetch_youtube(channels, cutoff, storage),
        "aihot": lambda: fetch_aihot(cutoff, storage),
        "github_trending": lambda: fetch_github_trending(github_radar_config, storage),
        "security_advisory": lambda: fetch_security_advisories(
            security_advisory_config, cutoff, storage
        ),
        "model_hub": lambda: fetch_huggingface_models(
            huggingface_radar_config, cutoff, storage
        ),
        "industry_digest": lambda: fetch_industry_digests(
            industry_digest_sources, cutoff, storage
        ),
        "builders_x": lambda: fetch_builders_x(builders_x_accounts, cutoff, storage),
    }
    collected: dict[str, tuple[list[ContentItem], SourceHealth]] = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {
            executor.submit(timed_collect, collector): name
            for name, collector in collectors.items()
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                collected[name] = future.result()
            except Exception as error:
                collected[name] = (
                    [],
                    SourceHealth(
                        name,
                        "error",
                        0,
                        1,
                        0,
                        f"unexpected family failure: {type(error).__name__}",
                    ),
                )

    official_items, official_health = collected["official_news"]
    youtube_items, youtube_health = collected["youtube"]
    aihot_items, aihot_health = collected["aihot"]
    github_items, github_health = collected["github_trending"]
    security_items, security_health = collected["security_advisory"]
    model_items, model_health = collected["model_hub"]
    industry_digest_items, industry_digest_health = collected["industry_digest"]
    builders_x_items, builders_x_health = collected["builders_x"]
    items = _deduplicate_items(
        [
            *official_items,
            *youtube_items,
            *aihot_items,
            *github_items,
            *security_items,
            *model_items,
            *industry_digest_items,
            *builders_x_items,
        ]
    )
    return items, [
        official_health,
        youtube_health,
        aihot_health,
        github_health,
        security_health,
        model_health,
        industry_digest_health,
        builders_x_health,
    ]
