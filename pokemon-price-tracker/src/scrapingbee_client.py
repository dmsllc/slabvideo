"""ScrapingBee fallback client for card image URLs."""

from __future__ import annotations

import json
import logging
import re
from urllib.parse import quote, urlparse

import requests

logger = logging.getLogger(__name__)

SCRAPINGBEE_API = "https://app.scrapingbee.com/api/v1/"
PRICECHARTING_SEARCH = "https://www.pricecharting.com/search-products"


class ScrapingBeeClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key.strip()
        self.session = requests.Session()

    def fetch_image_url(self, card_name: str, set_name: str, card_number: str) -> str | None:
        query = " ".join(
            part
            for part in (card_name, set_name, card_number.replace("#", ""))
            if part
        )
        search_url = f"{PRICECHARTING_SEARCH}?q={quote(query)}"

        extract_rules = {
            "cover": {
                "selector": "table img",
                "output": "@src",
            }
        }

        try:
            response = self.session.get(
                SCRAPINGBEE_API,
                params={
                    "api_key": self.api_key,
                    "url": search_url,
                    "render_js": "false",
                    "extract_rules": json.dumps(extract_rules),
                },
                timeout=60,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.error("ScrapingBee image lookup failed for %s: %s", query, exc)
            return None

        try:
            payload = response.json()
        except json.JSONDecodeError:
            logger.error("ScrapingBee returned non-JSON response for %s", query)
            return None

        cover = payload.get("cover")
        if isinstance(cover, str):
            return _normalize_https(cover)
        return None


def _normalize_https(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return None
    url = url.strip()
    if url.startswith("//"):
        url = f"https:{url}"
    if url.startswith("/"):
        return None
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    if not url.startswith("https://"):
        return None
    if not _looks_like_image(url):
        return None
    return url


def _looks_like_image(url: str) -> bool:
    lowered = url.lower()
    if "pricecharting.com" in lowered or "storage.googleapis.com/images.pricecharting" in lowered:
        return True
    if re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", lowered):
        return True
    parsed = urlparse(url)
    return bool(parsed.netloc)
