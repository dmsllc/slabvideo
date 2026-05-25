"""ScrapingBee fallback client for card image URLs."""

from __future__ import annotations

import json
import logging
import re
from urllib.parse import quote, urljoin, urlparse

import requests

logger = logging.getLogger(__name__)

SCRAPINGBEE_API = "https://app.scrapingbee.com/api/v1/"


class ScrapingBeeClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key.strip()
        self.session = requests.Session()

    def fetch_image_url(self, card_name: str, set_name: str, card_number: str) -> str | None:
        query = f"{card_name} {set_name} {card_number} Pokemon PSA 10 card"
        search_url = f"https://www.google.com/search?q={quote(query)}&tbm=isch"

        extract_rules = {
            "images": {
                "selector": "img",
                "type": "list",
                "output": {
                    "src": "@src",
                    "data_src": "@data-src",
                },
            }
        }

        try:
            response = self.session.get(
                SCRAPINGBEE_API,
                params={
                    "api_key": self.api_key,
                    "url": search_url,
                    "render_js": "true",
                    "wait": "3000",
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

        images = payload.get("images", [])
        if not isinstance(images, list):
            return None

        for image in images:
            if not isinstance(image, dict):
                continue
            for key in ("src", "data_src"):
                url = _normalize_https(image.get(key))
                if url and _looks_like_image(url):
                    return url
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
    return url


def _looks_like_image(url: str) -> bool:
    lowered = url.lower()
    if "gstatic.com/images" in lowered or "google.com/images" in lowered:
        return False
    if re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", lowered):
        return True
    if "ebayimg.com" in lowered or "pricecharting.com" in lowered or "tcgplayer" in lowered:
        return True
    parsed = urlparse(url)
    return bool(parsed.netloc)
