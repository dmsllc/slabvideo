"""Build output rows from cards master and pricing data."""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from pricecharting_client import PriceChartingClient, price_30_days_ago_target
from scrapingbee_client import ScrapingBeeClient

logger = logging.getLogger(__name__)

TEXT_2ZV_VALUE = "in the last 30 days"


def build_output_rows(
    cards_master: pd.DataFrame,
    price_client: PriceChartingClient | None,
    image_client: ScrapingBeeClient | None,
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    target_date = price_30_days_ago_target()

    for record in cards_master.to_dict(orient="records"):
        row = _build_row(record, price_client, image_client, target_date)
        rows.append(row)

    return rows


def _build_row(
    record: dict[str, Any],
    price_client: PriceChartingClient | None,
    image_client: ScrapingBeeClient | None,
    target_date: Any,
) -> dict[str, str]:
    pokemon = str(record.get("pokemon", "")).strip()
    card_name = str(record.get("card_name", "")).strip()
    set_name = str(record.get("set_name", "")).strip()
    card_number = str(record.get("card_number", "")).strip()
    product_id = str(record.get("pricecharting_product_id", "")).strip()
    image_url = str(record.get("image_url", "")).strip()

    identity = f"{card_name} | {set_name} | {card_number} | PSA 10"

    latest_price: float | None = None
    price_30d: float | None = None
    percent_change: float | None = None

    if product_id and price_client is not None:
        try:
            latest_price, price_30d = price_client.get_psa10_prices(product_id, target_date)
            percent_change = _calculate_percent_change(latest_price, price_30d)
        except Exception as exc:
            logger.error(
                "PriceCharting lookup failed for %s (product %s): %s",
                card_name,
                product_id,
                exc,
            )

    image = image_url if image_url.startswith("https://") else ""
    if not image and image_client is not None:
        fetched = image_client.fetch_image_url(card_name, set_name, card_number)
        if fetched:
            image = fetched

    output = {
        "Image-JZ4": image,
        "Text-99R": "",
        "Text-D72": identity,
        "Text-PLR": "",
        "Text-BJJ": "",
        "Text-2ZV": TEXT_2ZV_VALUE,
    }

    if latest_price is not None and price_30d is not None:
        output["Text-PLR"] = f"${price_30d:.2f} → ${latest_price:.2f}"

    if percent_change is not None:
        output["Text-BJJ"] = _format_percent(percent_change)
        output["Text-99R"] = _format_headline(pokemon, percent_change)

    return output


def _calculate_percent_change(latest: float | None, prior: float | None) -> float | None:
    if latest is None or prior is None:
        return None
    if prior <= 0:
        return None
    return round(((latest - prior) / prior) * 100, 2)


def _format_percent(value: float) -> str:
    if value > 0:
        return f"+{value:.2f}%"
    if value < 0:
        return f"{value:.2f}%"
    return "0.00%"


def _format_headline(pokemon: str, percent_change: float) -> str:
    if percent_change > 0:
        direction = "up"
    elif percent_change < 0:
        direction = "down"
    else:
        direction = "flat"
    magnitude = abs(percent_change)
    return f"{pokemon} {direction} {magnitude:.2f}% in 30 days"
