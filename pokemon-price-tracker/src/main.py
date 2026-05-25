"""Generate populated PSA 10 pricing CSV from cards master."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from csv_handler import load_cards_master, load_template, project_root, write_output
from pricecharting_client import PriceChartingClient
from scrapingbee_client import ScrapingBeeClient
from updater import build_output_rows

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    env_path = project_root() / ".env"
    load_dotenv(env_path)

    try:
        load_template()
    except ValueError as exc:
        print(str(exc))
        return 1

    try:
        cards_master = load_cards_master()
    except ValueError as exc:
        print(str(exc))
        return 1

    pricecharting_key = os.getenv("PRICECHARTING_API_KEY", "").strip()
    scrapingbee_key = os.getenv("SCRAPINGBEE_API_KEY", "").strip()

    price_client = PriceChartingClient(pricecharting_key) if pricecharting_key else None
    image_client = ScrapingBeeClient(scrapingbee_key) if scrapingbee_key else None

    if price_client is None:
        logger.warning("PRICECHARTING_API_KEY is not set; price fields will remain blank.")

    if image_client is None:
        logger.warning("SCRAPINGBEE_API_KEY is not set; missing images will remain blank.")

    rows = build_output_rows(cards_master, price_client, image_client)
    output_path = write_output(rows)
    logger.info("Wrote %s (%s rows)", output_path, len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
