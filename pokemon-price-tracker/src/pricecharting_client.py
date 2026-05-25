"""PriceCharting API client for PSA 10 pricing."""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

API_BASE = "https://www.pricecharting.com/api/product"
PSA10_PRICE_KEYS = ("manual-only-price", "psa-10-price", "psa10-price")
CHART_KEY = "manualonly"
RATE_LIMIT_SECONDS = 1.1
_last_request_at = 0.0


class PriceChartingClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key.strip()
        self.session = requests.Session()

    def _throttle(self) -> None:
        global _last_request_at
        elapsed = time.monotonic() - _last_request_at
        if elapsed < RATE_LIMIT_SECONDS:
            time.sleep(RATE_LIMIT_SECONDS - elapsed)
        _last_request_at = time.monotonic()

    def get_product(self, product_id: str) -> dict[str, Any]:
        self._throttle()
        response = self.session.get(
            API_BASE,
            params={"t": self.api_key, "id": product_id},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") == "error":
            raise RuntimeError(payload.get("error-message", "PriceCharting API error"))
        return payload

    def get_psa10_prices(
        self, product_id: str, target_date: datetime
    ) -> tuple[float | None, float | None]:
        """Return (latest PSA 10 price, PSA 10 price closest to target_date)."""
        product = self.get_product(product_id)
        latest = _first_price_cents(product, PSA10_PRICE_KEYS)
        latest_price = round(latest / 100, 2) if latest and latest > 0 else None

        page_url = _product_page_url(product, product_id)
        if not page_url:
            logger.warning("Could not determine PriceCharting page URL for product %s", product_id)
            return latest_price, None

        series = _fetch_manualonly_chart(self.session, page_url)
        prior_price = _closest_chart_price(series, target_date)
        return latest_price, prior_price


def _closest_chart_price(series: list[tuple[int, int]], target_date: datetime) -> float | None:
    if not series:
        return None

    target_ms = int(target_date.timestamp() * 1000)
    best_point: tuple[int, int] | None = None
    for timestamp_ms, price_cents in series:
        if price_cents <= 0:
            continue
        distance = abs(timestamp_ms - target_ms)
        if best_point is None or distance < best_point[0]:
            best_point = (distance, price_cents)

    if best_point is None:
        return None
    return round(best_point[1] / 100, 2)


def _first_price_cents(product: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = product.get(key)
        if value is None or value == "":
            continue
        try:
            cents = int(value)
        except (TypeError, ValueError):
            continue
        if cents > 0:
            return cents
    return None


def _slugify(value: str) -> str:
    slug = value.lower().strip()
    slug = slug.replace("&", "and")
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def _product_page_url(product: dict[str, Any], product_id: str) -> str | None:
    console = str(product.get("console-name", "")).strip()
    name = str(product.get("product-name", "")).strip()
    if console and name:
        return f"https://www.pricecharting.com/game/{_slugify(console)}/{_slugify(name)}"
    return f"https://www.pricecharting.com/search-products?q={quote(product_id)}"


def _fetch_manualonly_chart(session: requests.Session, page_url: str) -> list[tuple[int, int]]:
    global _last_request_at
    _last_request_at = time.monotonic()
    try:
        response = session.get(page_url, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.error("Failed to fetch PriceCharting chart page %s: %s", page_url, exc)
        return []

    match = re.search(r"chart_data\s*=\s*(\{.*?\});", response.text, re.DOTALL)
    if not match:
        return []

    try:
        chart_data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []

    manual_series = chart_data.get(CHART_KEY)
    if not isinstance(manual_series, list):
        return []

    points: list[tuple[int, int]] = []
    for entry in manual_series:
        if not isinstance(entry, list) or len(entry) < 2:
            continue
        try:
            points.append((int(entry[0]), int(entry[1])))
        except (TypeError, ValueError):
            continue
    return points


def price_30_days_ago_target() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=30)
