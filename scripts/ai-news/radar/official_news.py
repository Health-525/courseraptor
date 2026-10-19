"""Collect first-party announcements from feeds, changelogs, and bounded indexes."""

from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, NotRequired, TypedDict
from xml.etree import ElementTree as ET

from .models import ContentItem, SourceCheck, SourceHealth
from .storage import Storage
from .timezones import REPORT_TIMEZONE
from .url_utils import canonical_url, normalized_host

Fetcher = Callable[[str, Storage], tuple[bytes, bool]]
COLLECTION_LOOKBACK_HOURS = 96
MONTH_DATE_RE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|"
    r"Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b",
    re.IGNORECASE,
)
NUMERIC_DATE_RE = re.compile(
    r"\b(?P<year>20\d{2})[./](?P<month>\d{1,2})[./](?P<day>\d{1,2})\b"
)
EAST_ASIAN_DATE_RE = re.compile(
    r"(?P<year>20\d{2})年\s*(?P<month>\d{1,2})月\s*(?P<day>\d{1,2})日"
)
DATE_PUBLISHED_RE = re.compile(
    r"""\\?["']datePublished\\?["']\s*:\s*\\?["']([^"'\\]+)""",
    re.IGNORECASE,
)
CHANGELOG_DATE_RE = re.compile(
    r"(?P<iso>20\d{2}[-./]\d{1,2}[-./]\d{1,2})|"
    r"(?P<cn_full>(?P<cn_year>20\d{2})\s*年\s*(?P<cn_full_month>\d{1,2})\s*月\s*"
    r"(?P<cn_full_day>\d{1,2})\s*日?)|"
    r"(?P<cn_short>(?P<cn_short_month>\d{1,2})\s*月\s*"
    r"(?P<cn_short_day>\d{1,2})\s*日)|"
    r"(?P<month_first>(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
    r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
    r"Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})(?:,\s*(?P<month_year>20\d{2}))?|"
    r"(?P<day_first>\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|"
    r"Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|"
    r"Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))(?:\s+(?P<day_year>20\d{2}))?",
    re.IGNORECASE,
)
CHANGELOG_SECTION_YEAR_RE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|"
    r"Dec(?:ember)?)\s*,?\s*(?P<year>20\d{2})\b",
    re.IGNORECASE,
)
SEED_ROUTER_RE = re.compile(
    r"window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>",
    re.DOTALL,
)
PRERELEASE_TITLE_RE = re.compile(
    r"(?:^|[._-])(?:alpha|beta|rc|preview|nightly|dev|canary)(?:[._-]|\d|$)|\drc\d",
    re.IGNORECASE,
)


class OfficialSource(TypedDict):
    name: str
    kind: str
    allowed_hosts: list[str]
    url: NotRequired[str]
    index_url: NotRequired[str]
    article_path_prefix: NotRequired[str]
    excluded_path_prefixes: NotRequired[list[str]]
    max_candidates: NotRequired[int]
    article_url_template: NotRequired[str]
    allowed_categories: NotRequired[list[str]]
    title_include_terms: NotRequired[list[str]]
    title_exclude_terms: NotRequired[list[str]]
    max_items: NotRequired[int]
    allow_json_date: NotRequired[bool]
    allow_content_fallback: NotRequired[bool]
    stable_releases_only: NotRequired[bool]
    preserve_feed_entries: NotRequired[bool]


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() in {"script", "style"}:
            self.ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in {"script", "style"} and self.ignored_depth:
            self.ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.ignored_depth:
            self.parts.append(data)


class _IndexParser(HTMLParser):
    def __init__(
        self,
        base_url: str,
        allowed_hosts: set[str],
        article_prefix: str,
        excluded_prefixes: tuple[str, ...],
    ) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.allowed_hosts = allowed_hosts
        self.article_prefix = article_prefix
        self.excluded_prefixes = excluded_prefixes
        self.current: dict[str, object] | None = None
        self.records: dict[str, dict[str, str]] = {}
        self.order: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "a":
            return
        attributes = {key.casefold(): value or "" for key, value in attrs}
        href = attributes.get("href", "").strip()
        if not href:
            return
        url = urllib.parse.urljoin(self.base_url, href)
        parsed = urllib.parse.urlsplit(url)
        host = normalized_host(parsed.hostname or "")
        if (
            parsed.scheme != "https"
            or host not in self.allowed_hosts
            or not parsed.path.startswith(self.article_prefix)
            or parsed.path.rstrip("/") == self.article_prefix.rstrip("/")
            or any(parsed.path.startswith(prefix) for prefix in self.excluded_prefixes)
        ):
            return
        clean_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        self.current = {
            "url": clean_url,
            "label": attributes.get("label", "").strip(),
            "description": attributes.get("description", "").strip(),
            "text": [],
        }

    def handle_data(self, data: str) -> None:
        if self.current is not None:
            parts = self.current["text"]
            assert isinstance(parts, list)
            parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() != "a" or self.current is None:
            return
        url = str(self.current["url"])
        text_parts = self.current["text"]
        assert isinstance(text_parts, list)
        text = _clean_text(" ".join(str(part) for part in text_parts))
        record = self.records.get(url)
        if record is None:
            record = {"url": url, "label": "", "description": "", "text": ""}
            self.records[url] = record
            self.order.append(url)
        for key in ("label", "description"):
            value = str(self.current[key]).strip()
            if value and not record[key]:
                record[key] = value
        if text and text not in record["text"]:
            record["text"] = _clean_text(f"{record['text']} {text}")
        self.current = None

    def candidates(self, limit: int) -> list[dict[str, str]]:
        return [self.records[url] for url in self.order[:limit]]


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.in_title = False
        self.title_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.casefold(): value or "" for key, value in attrs}
        if tag.casefold() == "meta":
            key = (attributes.get("property") or attributes.get("name") or "").casefold()
            content = attributes.get("content", "").strip()
            if key and content:
                self.meta[key] = content
        elif tag.casefold() == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


class _ChangelogBlockParser(HTMLParser):
    block_tags = {
        "button",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "span",
        "time",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict[str, object]] = []
        self.events: list[tuple[str, str]] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "svg"}:
            self.ignored_depth += 1
            return
        if self.ignored_depth or normalized not in self.block_tags:
            return
        if self.stack:
            self.stack[-1]["has_block_child"] = True
        self.stack.append(
            {"tag": normalized, "parts": [], "has_block_child": False}
        )

    def handle_data(self, data: str) -> None:
        if self.stack and not self.ignored_depth:
            parts = self.stack[-1]["parts"]
            assert isinstance(parts, list)
            parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "svg"}:
            if self.ignored_depth:
                self.ignored_depth -= 1
            return
        if self.ignored_depth or not self.stack or self.stack[-1]["tag"] != normalized:
            return
        block = self.stack.pop()
        parts = block["parts"]
        assert isinstance(parts, list)
        text = _clean_text(" ".join(str(part) for part in parts))
        if text and not bool(block["has_block_child"]):
            self.events.append((normalized, text))


class _TableRowParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self.current_row: list[str] | None = None
        self.cell_parts: list[str] | None = None
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "svg"}:
            self.ignored_depth += 1
        elif not self.ignored_depth and normalized == "tr":
            self.current_row = []
        elif (
            not self.ignored_depth
            and normalized in {"td", "th"}
            and self.current_row is not None
        ):
            self.cell_parts = []

    def handle_data(self, data: str) -> None:
        if self.cell_parts is not None and not self.ignored_depth:
            self.cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "svg"}:
            if self.ignored_depth:
                self.ignored_depth -= 1
            return
        if self.ignored_depth:
            return
        if normalized in {"td", "th"} and self.cell_parts is not None:
            text = _clean_text(" ".join(self.cell_parts))
            if text and self.current_row is not None:
                self.current_row.append(text)
            self.cell_parts = None
        elif normalized == "tr" and self.current_row is not None:
            if self.current_row:
                self.rows.append(self.current_row)
            self.current_row = None


def _validate_https_url(value: object, label: str) -> str:
    url = str(value or "").strip()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"{label} must be an absolute HTTPS URL")
    return url


def load_official_sources(path: Path) -> list[OfficialSource]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"official source file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"official source file is invalid JSON: {error}") from error
    if not isinstance(payload, list) or not payload:
        raise ValueError("official source file must contain a non-empty array")

    sources: list[OfficialSource] = []
    seen_names: set[str] = set()
    for index, entry in enumerate(payload, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"official source {index} must be an object")
        name = str(entry.get("name", "")).strip()
        kind = str(entry.get("kind", "")).strip()
        normalized_name = name.casefold()
        if not name or normalized_name in seen_names:
            raise ValueError(f"official source {index} has an invalid or duplicate name")
        if kind not in {
            "rss",
            "html_index",
            "html_changelog",
            "qwen_api",
            "seed_router",
            "volcengine_router",
        }:
            raise ValueError(f"official source {index} has an unsupported kind")
        allowed_hosts_value = entry.get("allowed_hosts")
        if not isinstance(allowed_hosts_value, list) or not allowed_hosts_value:
            raise ValueError(f"official source {index} must define allowed_hosts")
        allowed_hosts = sorted(
            {normalized_host(str(host)) for host in allowed_hosts_value if str(host).strip()}
        )
        if not allowed_hosts:
            raise ValueError(f"official source {index} has no valid allowed host")

        normalized: OfficialSource = {
            "name": name,
            "kind": kind,
            "allowed_hosts": allowed_hosts,
        }
        for field in ("title_include_terms", "title_exclude_terms", "allowed_categories"):
            values = entry.get(field, [])
            if not isinstance(values, list) or any(not str(value).strip() for value in values):
                raise ValueError(f"official source {index} has invalid {field}")
            if values:
                normalized[field] = [str(value).strip() for value in values]
        if "max_items" in entry:
            max_items = entry["max_items"]
            if isinstance(max_items, bool) or not isinstance(max_items, int):
                raise ValueError(f"official source {index} has invalid max_items")
            if not 1 <= max_items <= 30:
                raise ValueError(
                    f"official source {index} max_items must be 1 through 30"
                )
            normalized["max_items"] = max_items
        allow_json_date = entry.get("allow_json_date", True)
        if not isinstance(allow_json_date, bool):
            raise ValueError(f"official source {index} has invalid allow_json_date")
        if not allow_json_date:
            normalized["allow_json_date"] = False
        allow_content_fallback = entry.get("allow_content_fallback", True)
        if not isinstance(allow_content_fallback, bool):
            raise ValueError(
                f"official source {index} has invalid allow_content_fallback"
            )
        if not allow_content_fallback:
            normalized["allow_content_fallback"] = False
        stable_releases_only = entry.get("stable_releases_only", False)
        if not isinstance(stable_releases_only, bool):
            raise ValueError(
                f"official source {index} has invalid stable_releases_only"
            )
        if stable_releases_only:
            if kind != "rss":
                raise ValueError(
                    f"official source {index} stable release filtering requires RSS"
                )
            normalized["stable_releases_only"] = True
        preserve_feed_entries = entry.get("preserve_feed_entries", False)
        if not isinstance(preserve_feed_entries, bool):
            raise ValueError(
                f"official source {index} has invalid preserve_feed_entries"
            )
        if preserve_feed_entries:
            if kind != "rss":
                raise ValueError(
                    f"official source {index} feed entry preservation requires RSS"
                )
            normalized["preserve_feed_entries"] = True

        if kind in {
            "rss",
            "html_changelog",
            "qwen_api",
            "seed_router",
            "volcengine_router",
        }:
            url = _validate_https_url(entry.get("url"), f"official source {index} url")
            if normalized_host(urllib.parse.urlsplit(url).hostname or "") not in allowed_hosts:
                raise ValueError(f"official source {index} URL host is not allowlisted")
            normalized["url"] = url
            if kind in {"qwen_api", "seed_router", "volcengine_router"}:
                template = str(entry.get("article_url_template", "")).strip()
                placeholder = "{id}" if kind == "volcengine_router" else "{slug}"
                if template.count(placeholder) != 1:
                    raise ValueError(
                        f"official source {index} article URL template must contain {placeholder}"
                    )
                test_url = _validate_https_url(
                    template.replace(placeholder, "example"),
                    f"official source {index} article URL template",
                )
                if normalized_host(
                    urllib.parse.urlsplit(test_url).hostname or ""
                ) not in allowed_hosts:
                    raise ValueError(
                        f"official source {index} article URL host is not allowlisted"
                    )
                normalized["article_url_template"] = template
        else:
            index_url = _validate_https_url(
                entry.get("index_url"), f"official source {index} index_url"
            )
            if normalized_host(urllib.parse.urlsplit(index_url).hostname or "") not in allowed_hosts:
                raise ValueError(f"official source {index} index host is not allowlisted")
            article_prefix = str(entry.get("article_path_prefix", "")).strip()
            if not article_prefix.startswith("/"):
                raise ValueError(f"official source {index} has an invalid article path prefix")
            excluded = entry.get("excluded_path_prefixes", [])
            if not isinstance(excluded, list) or any(
                not str(prefix).startswith("/") for prefix in excluded
            ):
                raise ValueError(f"official source {index} has invalid excluded path prefixes")
            try:
                max_candidates = int(entry.get("max_candidates", 12))
            except (TypeError, ValueError) as error:
                raise ValueError(f"official source {index} has invalid max_candidates") from error
            if not 1 <= max_candidates <= 30:
                raise ValueError(f"official source {index} max_candidates must be 1 through 30")
            normalized.update(
                {
                    "index_url": index_url,
                    "article_path_prefix": article_prefix,
                    "excluded_path_prefixes": [str(prefix) for prefix in excluded],
                    "max_candidates": max_candidates,
                }
            )
        seen_names.add(normalized_name)
        sources.append(normalized)
    return sources


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _html_to_text(value: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(value)
    except ValueError:
        return _clean_text(re.sub(r"<[^>]+>", " ", value))
    return _clean_text(" ".join(parser.parts))


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def _child_text(element: ET.Element, *names: str) -> str:
    accepted = {name.casefold() for name in names}
    for child in element:
        if _local_name(child.tag) in accepted and child.text:
            return child.text.strip()
    return ""


def _parse_published(value: str) -> tuple[datetime, bool]:
    normalized = value.strip()
    if not normalized:
        raise ValueError("published date is empty")
    date_only = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized))
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        parsed = parsedate_to_datetime(normalized)
        date_only = False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc), date_only


def _within_window(published_at: datetime, date_only: bool, cutoff: datetime) -> bool:
    if date_only:
        published_date = published_at.astimezone(REPORT_TIMEZONE).date()
        cutoff_date = cutoff.astimezone(REPORT_TIMEZONE).date()
        return published_date >= cutoff_date
    return published_at >= cutoff


def _month_date(value: str) -> tuple[datetime, bool] | None:
    numeric_match = NUMERIC_DATE_RE.search(value) or EAST_ASIAN_DATE_RE.search(value)
    if numeric_match:
        try:
            return (
                datetime(
                    int(numeric_match.group("year")),
                    int(numeric_match.group("month")),
                    int(numeric_match.group("day")),
                    tzinfo=timezone.utc,
                ),
                True,
            )
        except ValueError:
            return None
    match = MONTH_DATE_RE.search(value)
    if not match:
        return None
    for date_format in ("%b %d, %Y", "%B %d, %Y"):
        try:
            return (
                datetime.strptime(match.group(0), date_format).replace(tzinfo=timezone.utc),
                True,
            )
        except ValueError:
            continue
    return None


def _changelog_date(
    value: str,
    cutoff: datetime,
    context_year: int | None = None,
) -> tuple[datetime, bool] | None:
    match = CHANGELOG_DATE_RE.search(value)
    if not match:
        return None
    if match.group("iso"):
        return _parse_published(re.sub(r"[./]", "-", match.group("iso")))
    if match.group("cn_full"):
        try:
            return (
                datetime(
                    int(match.group("cn_year")),
                    int(match.group("cn_full_month")),
                    int(match.group("cn_full_day")),
                    tzinfo=timezone.utc,
                ),
                True,
            )
        except ValueError:
            return None
    if match.group("cn_short"):
        window_end = cutoff + timedelta(hours=COLLECTION_LOOKBACK_HOURS)
        try:
            parsed = datetime(
                window_end.year,
                int(match.group("cn_short_month")),
                int(match.group("cn_short_day")),
                tzinfo=timezone.utc,
            )
        except ValueError:
            return None
        if parsed > window_end + timedelta(days=31):
            parsed = parsed.replace(year=parsed.year - 1)
        return parsed, True
    date_text = match.group("month_first") or match.group("day_first")
    explicit_year = match.group("month_year") or match.group("day_year")
    if not date_text:
        return None
    window_end = cutoff + timedelta(hours=COLLECTION_LOOKBACK_HOURS)
    year = int(explicit_year) if explicit_year else context_year or window_end.year
    formats = ("%b %d %Y", "%B %d %Y", "%d %b %Y", "%d %B %Y")
    normalized = f"{date_text.replace(',', '')} {year}"
    for date_format in formats:
        try:
            parsed = datetime.strptime(normalized, date_format).replace(tzinfo=timezone.utc)
            if not explicit_year and parsed > window_end + timedelta(days=31):
                parsed = parsed.replace(year=parsed.year - 1)
            return parsed, True
        except ValueError:
            continue
    return None


def _allowed_article_url(value: str, allowed_hosts: set[str]) -> bool:
    parsed = urllib.parse.urlsplit(value)
    return parsed.scheme == "https" and normalized_host(parsed.hostname or "") in allowed_hosts


def _title_allowed(source: OfficialSource, title: str) -> bool:
    normalized = title.casefold()
    include = [term.casefold() for term in source.get("title_include_terms", [])]
    exclude = [term.casefold() for term in source.get("title_exclude_terms", [])]

    def matches(term: str) -> bool:
        if re.fullmatch(r"[a-z0-9]{1,3}", term):
            return bool(
                re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", normalized)
            )
        return term in normalized

    if source.get("stable_releases_only") and PRERELEASE_TITLE_RE.search(title):
        return False
    return (not include or any(matches(term) for term in include)) and not any(
        matches(term) for term in exclude
    )


def parse_official_feed(
    body: bytes,
    source: OfficialSource,
    cutoff: datetime,
) -> list[ContentItem]:
    root = ET.fromstring(body)
    root_name = _local_name(root.tag)
    if root_name == "rss":
        entries = root.findall("./channel/item")
    elif root_name == "feed":
        entries = [child for child in root if _local_name(child.tag) == "entry"]
    else:
        raise ValueError("official feed is neither RSS nor Atom")
    if not entries:
        raise ValueError("official feed contains no entries")

    allowed_hosts = {str(host) for host in source["allowed_hosts"]}
    items: list[ContentItem] = []
    for entry in entries:
        title = _child_text(entry, "title")
        published_text = _child_text(entry, "pubDate", "published", "updated", "date")
        description = _child_text(entry, "description", "summary")
        if not description and source.get("allow_content_fallback", True):
            description = _child_text(entry, "content", "encoded")
        guid = _child_text(entry, "guid", "id")
        category = _child_text(entry, "category")
        link = _child_text(entry, "link")
        if not link:
            for child in entry:
                if _local_name(child.tag) == "link":
                    rel = child.attrib.get("rel", "alternate")
                    href = child.attrib.get("href", "")
                    if rel in {"", "alternate"} and href:
                        link = href.strip()
                        break
        if (
            not title
            or not _title_allowed(source, title)
            or not published_text
            or not link
            or not _allowed_article_url(link, allowed_hosts)
        ):
            continue
        try:
            published_at, date_only = _parse_published(published_text)
        except (TypeError, ValueError):
            continue
        if not _within_window(published_at, date_only, cutoff):
            continue
        url_key = canonical_url(link)
        item_id = hashlib.sha256((guid or url_key).encode("utf-8")).hexdigest()[:24]
        item_url = link
        if source.get("preserve_feed_entries"):
            item_url = urllib.parse.urlunsplit(
                urllib.parse.urlsplit(link)._replace(fragment=f"entry-{item_id}")
            )
        extra = (
            "官方 Release Notes"
            if source.get("preserve_feed_entries")
            else f"官方 RSS{f' · {category}' if category else ''}"
        )
        items.append(
            ContentItem(
                item_id=item_id,
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=_clean_text(title),
                published_at=published_at,
                url=item_url,
                raw_source_text=_html_to_text(description),
                extra=extra,
            )
        )
    return items


def parse_official_changelog(
    body: bytes,
    source: OfficialSource,
    cutoff: datetime,
) -> list[ContentItem]:
    parser = _ChangelogBlockParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    table_parser = _TableRowParser()
    table_parser.feed(body.decode("utf-8", errors="replace"))
    date_tags = {
        "button",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "span",
        "time",
    }
    content_tags = {"div", "h3", "h4", "h5", "h6", "li", "p", "span"}
    window_end = cutoff + timedelta(hours=COLLECTION_LOOKBACK_HOURS)
    current_date: datetime | None = None
    current_year: int | None = None
    chunks_by_date: dict[str, list[str]] = {}
    saw_dated_entry = False
    saw_in_window_date = False
    for row in table_parser.rows:
        dated_cells = [
            (index, parsed)
            for index, cell in enumerate(row)
            if len(cell) <= 48 and (parsed := _changelog_date(cell, cutoff)) is not None
        ]
        if not dated_cells:
            continue
        saw_dated_entry = True
        date_index, (published_at, _) = dated_cells[0]
        if not cutoff.date() <= published_at.date() <= window_end.date():
            continue
        saw_in_window_date = True
        date_key = published_at.date().isoformat()
        chunks = chunks_by_date.setdefault(date_key, [])
        for index, cell in enumerate(row):
            if (
                index != date_index
                and len(cell) >= 2
                and cell not in chunks
                and len(chunks) < 30
            ):
                chunks.append(cell)
    for tag, text in parser.events:
        section_year = CHANGELOG_SECTION_YEAR_RE.search(text)
        if section_year is not None and tag in date_tags and len(text) <= 48:
            current_year = int(section_year.group("year"))
            current_date = None
            continue
        published = (
            _changelog_date(text, cutoff, current_year)
            if tag in date_tags and len(text) <= 48
            else None
        )
        if published is not None:
            saw_dated_entry = True
            published_at, _ = published
            if cutoff.date() <= published_at.date() <= window_end.date():
                saw_in_window_date = True
            current_date = (
                published_at
                if cutoff.date() <= published_at.date() <= window_end.date()
                else None
            )
            continue
        if current_date is None or tag not in content_tags or len(text) < 20:
            continue
        date_key = current_date.date().isoformat()
        chunks = chunks_by_date.setdefault(date_key, [])
        if text not in chunks and len(chunks) < 30:
            chunks.append(text)

    url = source.get("url", "")
    items: list[ContentItem] = []
    for date_key, chunks in chunks_by_date.items():
        source_text = _clean_text(" ".join(chunks))[:6000]
        if not source_text:
            continue
        published_at = datetime.fromisoformat(date_key).replace(tzinfo=timezone.utc)
        identity = f"{source['name']}:{date_key}"
        dated_url = urllib.parse.urlunsplit(
            urllib.parse.urlsplit(url)._replace(fragment=date_key)
        )
        items.append(
            ContentItem(
                item_id=hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24],
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=f"{source['name']} · {date_key} 更新",
                published_at=published_at,
                url=dated_url,
                raw_source_text=source_text,
                extra="官方 Changelog",
            )
        )
    if not saw_dated_entry:
        raise ValueError("official changelog has no parseable dated entries")
    if saw_in_window_date and not items:
        raise ValueError("official changelog has no usable text for in-window entries")
    return items


def parse_qwen_api(
    body: bytes,
    source: OfficialSource,
    cutoff: datetime,
) -> list[ContentItem]:
    payload = json.loads(body.decode("utf-8"))
    data = payload.get("data") if isinstance(payload, dict) else None
    articles = data.get("articles") if isinstance(data, dict) else None
    if not isinstance(articles, list):
        raise ValueError("Qwen API payload has no article list")
    template = source.get("article_url_template", "")
    allowed_hosts = set(source["allowed_hosts"])
    items: list[ContentItem] = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        extra = article.get("extra")
        if not isinstance(extra, dict):
            continue
        try:
            published_at, date_only = _parse_published(str(extra.get("date", "")))
        except ValueError:
            continue
        title = _clean_text(str(article.get("title", "")))
        slug = str(article.get("path", "")).strip()
        if (
            not title
            or not slug
            or not _title_allowed(source, title)
            or not _within_window(published_at, date_only, cutoff)
        ):
            continue
        url = template.replace("{slug}", urllib.parse.quote(slug, safe="-._~"))
        if not _allowed_article_url(url, allowed_hosts):
            continue
        introduction = str(extra.get("introduction") or extra.get("description") or "")
        items.append(
            ContentItem(
                item_id=hashlib.sha256(slug.encode("utf-8")).hexdigest()[:24],
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=title,
                published_at=published_at,
                url=url,
                raw_source_text=_html_to_text(introduction)[:6000],
                extra="官方 JSON",
            )
        )
    return items


def parse_seed_router(
    body: bytes,
    source: OfficialSource,
    cutoff: datetime,
) -> list[ContentItem]:
    match = SEED_ROUTER_RE.search(body.decode("utf-8", errors="replace"))
    if not match:
        raise ValueError("Seed page has no router data")
    payload = json.loads(match.group(1))
    loader_data = payload.get("loaderData") if isinstance(payload, dict) else None
    if not isinstance(loader_data, dict):
        raise ValueError("Seed router data has no loader data")
    page = next(
        (
            value
            for key, value in loader_data.items()
            if key.endswith("/blog/page") and isinstance(value, dict)
        ),
        None,
    )
    articles = page.get("article_list") if isinstance(page, dict) else None
    if not isinstance(articles, list):
        raise ValueError("Seed router data has no article list")
    allowed_categories = {
        category.casefold() for category in source.get("allowed_categories", [])
    }
    template = source.get("article_url_template", "")
    allowed_hosts = set(source["allowed_hosts"])
    items: list[ContentItem] = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        metadata = article.get("ArticleMeta")
        content = article.get("ArticleSubContentZh")
        if not isinstance(metadata, dict) or not isinstance(content, dict):
            continue
        areas = metadata.get("ResearchArea", [])
        categories = {
            str(area.get("ResearchAreaName", "")).casefold()
            for area in areas
            if isinstance(area, dict)
        }
        if allowed_categories and not allowed_categories.intersection(categories):
            continue
        try:
            published_at = datetime.fromtimestamp(
                int(metadata.get("PublishDate", 0)) / 1000,
                tz=timezone.utc,
            )
        except (TypeError, ValueError, OSError):
            continue
        title = _clean_text(str(content.get("Title", "")))
        slug = str(content.get("TitleKey", "")).strip()
        if (
            not title
            or not slug
            or not _title_allowed(source, title)
            or not _within_window(published_at, True, cutoff)
        ):
            continue
        url = template.replace("{slug}", urllib.parse.quote(slug, safe="-._~"))
        if not _allowed_article_url(url, allowed_hosts):
            continue
        items.append(
            ContentItem(
                item_id=hashlib.sha256(slug.encode("utf-8")).hexdigest()[:24],
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=title,
                published_at=published_at,
                url=url,
                raw_source_text=_clean_text(str(content.get("Abstract", "")))[:6000],
                extra="官方 Embedded Index",
            )
        )
    return items


def parse_volcengine_router(
    body: bytes,
    source: OfficialSource,
    cutoff: datetime,
) -> list[ContentItem]:
    match = SEED_ROUTER_RE.search(body.decode("utf-8", errors="replace"))
    if not match:
        raise ValueError("Volcengine page has no router data")
    payload = json.loads(match.group(1))
    loader_data = payload.get("loaderData") if isinstance(payload, dict) else None
    if not isinstance(loader_data, dict):
        raise ValueError("Volcengine router data has no loader data")
    page = next(
        (
            value
            for key, value in loader_data.items()
            if key.endswith("/news/page") and isinstance(value, dict)
        ),
        None,
    )
    article_container = page.get("listOnlineArticle") if isinstance(page, dict) else None
    articles = article_container.get("List") if isinstance(article_container, dict) else None
    if not isinstance(articles, list):
        raise ValueError("Volcengine router data has no article list")

    allowed_categories = {
        category.casefold() for category in source.get("allowed_categories", [])
    }
    allowed_hosts = set(source["allowed_hosts"])
    template = source.get("article_url_template", "")
    items: list[ContentItem] = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        categories = {
            str(article.get("CategoryCode", "")).casefold(),
            str(article.get("CategoryCodeName", "")).casefold(),
        }
        if allowed_categories and not allowed_categories.intersection(categories):
            continue
        try:
            published_at, date_only = _parse_published(
                str(article.get("CreatedTime", ""))
            )
        except (TypeError, ValueError):
            continue
        title = _clean_text(str(article.get("Title", "")))
        document_id = str(article.get("DocumentID", "")).strip()
        if (
            not title
            or not document_id.isdigit()
            or not _title_allowed(source, title)
            or not _within_window(published_at, date_only, cutoff)
        ):
            continue
        url = template.replace("{id}", document_id)
        if not _allowed_article_url(url, allowed_hosts):
            continue
        description = article.get("Summary") or article.get("Description") or ""
        items.append(
            ContentItem(
                item_id=hashlib.sha256(document_id.encode("utf-8")).hexdigest()[:24],
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=title,
                published_at=published_at,
                url=url,
                raw_source_text=_html_to_text(str(description))[:6000],
                extra="官方 Embedded Index",
            )
        )
    return items


def _extract_published(
    metadata: _MetadataParser,
    raw_html: str,
    index_text: str,
    allow_json_date: bool = True,
) -> tuple[datetime, bool] | None:
    for key in ("article:published_time", "datepublished", "date", "publish_date"):
        value = metadata.meta.get(key, "")
        if value:
            try:
                return _parse_published(value)
            except ValueError:
                pass
    if allow_json_date:
        normalized_html = html.unescape(raw_html).replace('\\"', '"')
        date_match = DATE_PUBLISHED_RE.search(normalized_html)
        if date_match:
            try:
                return _parse_published(date_match.group(1))
            except ValueError:
                pass
    return _month_date(index_text)


def _article_metadata(
    body: bytes,
    index_text: str,
    allow_json_date: bool = True,
) -> tuple[str, str, datetime, bool] | None:
    raw_html = body.decode("utf-8", errors="replace")
    parser = _MetadataParser()
    parser.feed(raw_html)
    published = _extract_published(parser, raw_html, index_text, allow_json_date)
    if published is None:
        return None
    title = (
        parser.meta.get("og:title")
        or parser.meta.get("twitter:title")
        or _clean_text(" ".join(parser.title_parts))
    )
    description = (
        parser.meta.get("og:description")
        or parser.meta.get("description")
        or parser.meta.get("twitter:description")
        or ""
    )
    return _clean_text(title), _html_to_text(description), *published


def _parse_official_index(
    index_body: bytes,
    source: OfficialSource,
    cutoff: datetime,
    storage: Storage,
    fetcher: Fetcher,
) -> tuple[list[ContentItem], int, int]:
    index_url = source.get("index_url", "")
    article_prefix = source.get("article_path_prefix", "")
    excluded_prefixes = source.get("excluded_path_prefixes", [])
    max_candidates = source.get("max_candidates", 12)
    if not index_url or not article_prefix:
        raise ValueError("HTML official source is missing its validated index configuration")
    allowed_hosts = {str(host) for host in source["allowed_hosts"]}
    parser = _IndexParser(
        index_url,
        allowed_hosts,
        article_prefix,
        tuple(excluded_prefixes),
    )
    parser.feed(index_body.decode("utf-8", errors="replace"))
    candidates = parser.candidates(max_candidates)
    if not candidates:
        raise ValueError("official index contains no matching article links")
    items: list[ContentItem] = []
    cached_requests = 0
    failed_articles = 0
    for candidate in candidates:
        index_published = _month_date(candidate["text"])
        if index_published is not None and not _within_window(*index_published, cutoff):
            continue
        try:
            article_body, cached = fetcher(candidate["url"], storage)
            cached_requests += int(cached)
            metadata = _article_metadata(
                article_body,
                candidate["text"],
                source.get("allow_json_date", True),
            )
        except Exception:
            failed_articles += 1
            continue
        if metadata is None:
            continue
        title, description, published_at, date_only = metadata
        if (
            index_published is not None
            and index_published[1]
            and index_published[0].date() == published_at.date()
            and published_at.time() == datetime.min.time()
        ):
            # Newsrooms commonly serialize a date-only value as midnight UTC.
            date_only = True
        if not title:
            title = candidate["label"]
        if not description:
            description = candidate["description"]
        if (
            not title
            or not _title_allowed(source, title)
            or not _within_window(published_at, date_only, cutoff)
        ):
            continue
        url_key = canonical_url(candidate["url"])
        items.append(
            ContentItem(
                item_id=hashlib.sha256(url_key.encode("utf-8")).hexdigest()[:24],
                source_type="official_news",
                source=f"官方发布 · {source['name']}",
                title=title,
                published_at=published_at,
                url=candidate["url"],
                raw_source_text=description,
                extra="官方 Newsroom",
            )
        )
    return items, cached_requests, failed_articles


def fetch_official_news(
    sources: list[OfficialSource],
    cutoff: datetime,
    storage: Storage,
    fetcher: Fetcher,
) -> tuple[list[ContentItem], SourceHealth]:
    def collect_one(
        index: int, source: OfficialSource
    ) -> tuple[int, list[ContentItem], int, int, SourceCheck, str]:
        started = time.monotonic()
        cached_requests = 0
        article_failures = 0
        try:
            kind = source["kind"]
            if kind in {
                "rss",
                "html_changelog",
                "qwen_api",
                "seed_router",
                "volcengine_router",
            }:
                feed_url = source.get("url", "")
                if not feed_url:
                    raise ValueError("official source is missing its validated URL")
                body, cached = fetcher(feed_url, storage)
                cached_requests += int(cached)
                if kind == "rss":
                    source_items = parse_official_feed(body, source, cutoff)
                elif kind == "html_changelog":
                    source_items = parse_official_changelog(body, source, cutoff)
                elif kind == "qwen_api":
                    source_items = parse_qwen_api(body, source, cutoff)
                elif kind == "seed_router":
                    source_items = parse_seed_router(body, source, cutoff)
                else:
                    source_items = parse_volcengine_router(body, source, cutoff)
            else:
                index_url = source.get("index_url", "")
                if not index_url:
                    raise ValueError("HTML official source is missing its validated index URL")
                body, cached = fetcher(index_url, storage)
                cached_requests += int(cached)
                source_items, article_cache, article_failures = _parse_official_index(
                    body, source, cutoff, storage, fetcher
                )
                cached_requests += article_cache
            matching_items = len(source_items)
            max_items = source.get("max_items")
            if max_items is not None and matching_items > max_items:
                source_items = sorted(
                    source_items,
                    key=lambda item: (item.published_at, item.item_id),
                    reverse=True,
                )[:max_items]
            elapsed_ms = round((time.monotonic() - started) * 1000)
            if article_failures:
                source_detail = f"{article_failures} article metadata failures"
            elif matching_items > len(source_items):
                source_detail = f"limited {matching_items} matching items to {len(source_items)}"
            elif not source_items:
                source_detail = "no in-window items"
            else:
                source_detail = "fetched"
            return (
                index,
                source_items,
                cached_requests,
                article_failures,
                SourceCheck(
                    name=str(source["name"]),
                    status="warn" if article_failures or elapsed_ms >= 30_000 else "ok",
                    items=len(source_items),
                    cached=cached_requests,
                    detail=f"{source_detail}; {elapsed_ms}ms",
                ),
                "",
            )
        except Exception as error:
            source_name = str(source["name"])
            failure_detail = (
                str(error)[:160]
                if isinstance(error, ValueError) and str(error)
                else type(error).__name__
            )
            elapsed_ms = round((time.monotonic() - started) * 1000)
            return (
                index,
                [],
                cached_requests,
                article_failures,
                SourceCheck(
                    name=source_name,
                    status="error",
                    items=0,
                    cached=cached_requests,
                    detail=f"{failure_detail}; {elapsed_ms}ms",
                ),
                source_name,
            )

    results: list[tuple[int, list[ContentItem], int, int, SourceCheck, str]] = []
    with ThreadPoolExecutor(max_workers=min(12, len(sources))) as executor:
        futures = {
            executor.submit(collect_one, index, source): index
            for index, source in enumerate(sources)
        }
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda result: result[0])
    items = [item for result in results for item in result[1]]
    cached_requests = sum(result[2] for result in results)
    failed_articles = sum(result[3] for result in results)
    source_checks = [result[4] for result in results]
    failed_sources = [result[5] for result in results if result[5]]
    fetched_sources = len(sources) - len(failed_sources)
    slow_sources = [check.name for check in source_checks if check.status == "warn"]

    if not fetched_sources:
        status = "error"
    elif failed_sources or failed_articles or slow_sources:
        status = "warn"
    else:
        status = "ok"
    detail = (
        f"{len(sources)} configured sources; {fetched_sources} fetched; "
        f"{len(failed_sources)} source failures; {failed_articles} article failures; "
        f"{len(slow_sources)} slow/warn sources; {len(items)} items"
    )
    if failed_sources:
        detail += f"; unavailable: {', '.join(failed_sources)}"
    return items, SourceHealth(
        "official_news",
        status,
        fetched_sources,
        len(failed_sources),
        cached_requests,
        detail,
        tuple(source_checks),
    )
