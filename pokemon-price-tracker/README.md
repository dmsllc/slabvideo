# Pokémon PSA 10 Price Tracker

Deterministic CSV updater for a fixed Creatomate/sheet template. It reads a permanent card universe from `data/cards_master.csv`, fetches PriceCharting PSA 10 prices where product IDs are set, and writes `data/output.csv` with the same columns and order as `data/template.csv`.

## Project layout

- `data/template.csv` — column schema and example formatting row (not included in output)
- `data/cards_master.csv` — 250-card universe (25 Pokémon × 10 cards); identity fields are edited by you
- `data/output.csv` — generated feed (overwritten on each run)
- `src/main.py` — entry point

## Template

Place your slabfolio/CSV template at `data/template.csv`. Required columns, in this exact order:

`Image-JZ4`, `Text-99R`, `Text-D72`, `Text-PLR`, `Text-BJJ`, `Text-2ZV`

The script validates the header before running. The example row in the template is for formatting reference only.

## API keys

Copy `.env.example` to `.env` in the project root:

```sh
cp .env.example .env
```

Set:

- `PRICECHARTING_API_KEY` — PriceCharting API token (`t` parameter)
- `SCRAPINGBEE_API_KEY` — ScrapingBee key (image fallback only)

Never commit `.env`.

## Filling `cards_master.csv`

Columns: `pokemon`, `card_name`, `set_name`, `card_number`, `pricecharting_product_id`, `image_url`

- Keep the starter 250 rows or edit card identity fields as needed.
- Add real PriceCharting product IDs when you know them; leave blank if unknown (prices stay blank; identity still outputs).
- Optional `image_url` must be a full `https://` URL; the script does not modify master columns.

## Run

```sh
cd pokemon-price-tracker
pip install -r requirements.txt
python src/main.py
```

## Output

`data/output.csv` contains one row per `cards_master.csv` row with:

- **Image-JZ4** — master `image_url` or ScrapingBee fallback
- **Text-99R** — e.g. `Charizard up 12.44% in 30 days`
- **Text-D72** — `{card_name} | {set_name} | {card_number} | PSA 10`
- **Text-PLR** — e.g. `$125.00 → $140.55`
- **Text-BJJ** — e.g. `+12.44%`
- **Text-2ZV** — always `in the last 30 days`

Pricing uses PriceCharting PSA 10 (`manual-only-price`) for the latest value and the `manualonly` chart series on the product page for the price closest to ~30 days ago. API failures log errors and leave affected price fields blank for that row.
