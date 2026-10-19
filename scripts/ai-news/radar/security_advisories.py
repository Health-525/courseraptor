"""Collect reviewed security advisories for allowlisted AI dependencies."""

from __future__ import annotations

import gzip
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, TypedDict

from .models import ContentItem, SourceCheck, SourceHealth
from .storage import Storage

GITHUB_ADVISORIES_API = "https://api.github.com/advisories"
GITHUB_API_VERSION = "2022-11-28"
FETCH_TIMEOUT_SECONDS = 20
CACHE_FALLBACK_HOURS = 36
LOCAL_CACHE_REUSE_MINUTES = 15


class SecurityAdvisoryConfig(TypedDict):
    packages: list[dict[str, str]]
    severities: list[str]
    max_items: int


def load_security_advisory_config(path: Path) -> SecurityAdvisoryConfig:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"security advisory config is unavailable: {error}") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("security advisory config requires schema_version 1")
    packages = payload.get("packages")
    severities = payload.get("severities", ["high", "critical"])
    max_items = payload.get("max_items", 12)
    if not isinstance(packages, list) or not packages:
        raise ValueError("security advisory config requires packages")
    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for entry in packages:
        if not isinstance(entry, dict):
            raise ValueError("security advisory package must be an object")
        ecosystem = str(entry.get("ecosystem", "")).strip().casefold()
        name = str(entry.get("name", "")).strip()
        key = (ecosystem, name.casefold())
        if ecosystem not in {"pip", "npm", "go", "rust", "actions"} or not name or key in seen:
            raise ValueError("security advisory package is invalid or duplicated")
        seen.add(key)
        normalized.append({"ecosystem": ecosystem, "name": name})
    if (
        not isinstance(severities, list)
        or not severities
        or any(value not in {"medium", "high", "critical"} for value in severities)
    ):
        raise ValueError("security advisory severities are invalid")
    if isinstance(max_items, bool) or not isinstance(max_items, int) or not 1 <= max_items <= 30:
        raise ValueError("security advisory max_items must be 1 through 30")
    return {
        "packages": normalized,
        "severities": list(dict.fromkeys(severities)),
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
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ai-news-skills/2.0",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }
    token = os.environ.get("AI_NEWS_GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
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
            return json.loads(body), False
    except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        if cache and _cache_recent(cache):
            return json.loads(bytes(cache["body"])), True
        raise


def _published(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_security_advisories(
    config: SecurityAdvisoryConfig,
    cutoff: datetime,
    storage: Storage,
    fetcher: Callable[[str, Storage], tuple[object, bool]] = _fetch_json,
) -> tuple[list[ContentItem], SourceHealth]:
    packages_by_ecosystem: dict[str, list[str]] = {}
    for package in config["packages"]:
        packages_by_ecosystem.setdefault(package["ecosystem"], []).append(package["name"])
    allowlisted = {
        (package["ecosystem"], package["name"].casefold()) for package in config["packages"]
    }
    accepted: dict[str, ContentItem] = {}
    checks: list[SourceCheck] = []
    cached_count = 0
    failed = 0
    for ecosystem, names in packages_by_ecosystem.items():
        for severity in config["severities"]:
            query: list[tuple[str, str]] = [
                ("ecosystem", ecosystem),
                ("severity", severity),
                ("modified", f">={cutoff.date().isoformat()}"),
                ("per_page", "100"),
            ]
            query.extend(("affects[]", name) for name in names)
            url = f"{GITHUB_ADVISORIES_API}?{urllib.parse.urlencode(query)}"
            try:
                payload, cached = fetcher(url, storage)
                cached_count += int(cached)
                if not isinstance(payload, list):
                    raise ValueError("GitHub advisory response is not an array")
                matched = 0
                for advisory in payload:
                    if not isinstance(advisory, dict):
                        continue
                    vulnerabilities = advisory.get("vulnerabilities", [])
                    affected: list[str] = []
                    for vulnerability in vulnerabilities if isinstance(vulnerabilities, list) else []:
                        package = vulnerability.get("package", {}) if isinstance(vulnerability, dict) else {}
                        package_ecosystem = str(package.get("ecosystem", "")).casefold()
                        package_name = str(package.get("name", "")).strip()
                        if (package_ecosystem, package_name.casefold()) not in allowlisted:
                            continue
                        version_range = str(vulnerability.get("vulnerable_version_range", "")).strip()
                        patched = vulnerability.get("first_patched_version")
                        patched_text = str(patched or "未提供修复版本").strip()
                        affected.append(f"{package_name} {version_range}; fixed: {patched_text}")
                    if not affected:
                        continue
                    observed_at = _published(advisory.get("updated_at") or advisory.get("published_at"))
                    if observed_at < cutoff:
                        continue
                    ghsa_id = str(advisory.get("ghsa_id", "")).strip()
                    summary = str(advisory.get("summary", "")).strip()
                    description = str(advisory.get("description", "")).strip()
                    html_url = str(advisory.get("html_url", "")).strip()
                    if not ghsa_id or not summary or not html_url.startswith("https://github.com/advisories/"):
                        continue
                    cve = str(advisory.get("cve_id") or "无 CVE").strip()
                    raw_text = (
                        f"GitHub-reviewed advisory {ghsa_id}; CVE: {cve}; severity: {severity}. "
                        f"Summary: {summary}. Affected: {' | '.join(affected)}. "
                        f"Description: {description[:4000]}"
                    )
                    accepted[ghsa_id] = ContentItem(
                        item_id=f"{ghsa_id}:{observed_at.date().isoformat()}",
                        source_type="security_advisory",
                        source="GitHub Advisory Database",
                        title=f"{ghsa_id} · {summary}",
                        published_at=observed_at,
                        url=html_url,
                        raw_source_text=raw_text,
                        extra="GitHub-reviewed security advisory",
                    )
                    matched += 1
                checks.append(
                    SourceCheck(
                        f"{ecosystem}:{severity}",
                        "ok",
                        matched,
                        int(cached),
                        "allowlisted dependency advisories",
                    )
                )
            except Exception as error:
                failed += 1
                checks.append(
                    SourceCheck(
                        f"{ecosystem}:{severity}",
                        "error",
                        0,
                        0,
                        type(error).__name__,
                    )
                )
    items = sorted(accepted.values(), key=lambda item: item.published_at, reverse=True)[
        : config["max_items"]
    ]
    fetched = len(checks) - failed
    status = "error" if not fetched else "warn" if failed else "ok"
    return items, SourceHealth(
        "security_advisory",
        status,
        fetched,
        failed,
        cached_count,
        f"{len(config['packages'])} packages; {len(items)} advisories; {failed} query failures",
        tuple(checks),
    )
