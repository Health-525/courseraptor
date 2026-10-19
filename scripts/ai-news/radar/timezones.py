"""Provide the reporting timezone without requiring an external tzdata package."""

from __future__ import annotations

from datetime import timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def load_report_timezone() -> tzinfo:
    """Return Asia/Shanghai, with a current-era UTC+8 fallback for minimal Windows hosts."""

    try:
        return ZoneInfo("Asia/Shanghai")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=8), name="Asia/Shanghai")


REPORT_TIMEZONE = load_report_timezone()
