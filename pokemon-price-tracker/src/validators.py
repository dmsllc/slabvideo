"""Schema validation for template and output CSV files."""

from __future__ import annotations

REQUIRED_OUTPUT_COLUMNS = [
    "Image-JZ4",
    "Text-99R",
    "Text-D72",
    "Text-PLR",
    "Text-BJJ",
    "Text-2ZV",
]

CARDS_MASTER_COLUMNS = [
    "pokemon",
    "card_name",
    "set_name",
    "card_number",
    "pricecharting_product_id",
    "image_url",
]


def validate_template_schema(columns: list[str]) -> None:
    """Raise ValueError with an exact message if columns do not match the template."""
    if columns == REQUIRED_OUTPUT_COLUMNS:
        return

    expected = ", ".join(REQUIRED_OUTPUT_COLUMNS)
    actual = ", ".join(columns)
    if set(columns) != set(REQUIRED_OUTPUT_COLUMNS):
        if len(columns) != len(REQUIRED_OUTPUT_COLUMNS):
            raise ValueError(
                f"Schema error: expected {len(REQUIRED_OUTPUT_COLUMNS)} columns "
                f"({expected}), found {len(columns)} ({actual})."
            )
        raise ValueError(
            f"Schema error: column names must be exactly [{expected}], found [{actual}]."
        )
    raise ValueError(
        f"Schema error: columns are correct but reordered. "
        f"Expected order: [{expected}]. Found: [{actual}]."
    )


def validate_cards_master_schema(columns: list[str]) -> None:
    if columns != CARDS_MASTER_COLUMNS:
        expected = ", ".join(CARDS_MASTER_COLUMNS)
        actual = ", ".join(columns)
        raise ValueError(
            f"cards_master.csv schema error: expected columns [{expected}], found [{actual}]."
        )
