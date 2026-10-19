"""Shared URL normalization helpers for source deduplication."""

from __future__ import annotations

import urllib.parse

TRACKING_QUERY_KEYS = {"fbclid", "gclid", "ref", "source"}


def normalized_host(value: str) -> str:
    normalized = value.strip().casefold().rstrip(".")
    return normalized[4:] if normalized.startswith("www.") else normalized


def canonical_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    query = [
        (key, item)
        for key, item in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if not key.casefold().startswith("utm_")
        and key.casefold() not in TRACKING_QUERY_KEYS
    ]
    path = parsed.path.rstrip("/") or "/"
    host = normalized_host(parsed.hostname or "")
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urllib.parse.urlunsplit(
        (
            parsed.scheme.casefold(),
            host,
            path,
            urllib.parse.urlencode(sorted(query)),
            "",
        )
    )
