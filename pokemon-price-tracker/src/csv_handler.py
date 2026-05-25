"""Read and write project CSV files."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from validators import CARDS_MASTER_COLUMNS, REQUIRED_OUTPUT_COLUMNS, validate_cards_master_schema, validate_template_schema


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_template(path: Path | None = None) -> pd.DataFrame:
    template_path = path or project_root() / "data" / "template.csv"
    df = pd.read_csv(template_path, dtype=str, keep_default_na=False)
    validate_template_schema(list(df.columns))
    return df


def load_cards_master(path: Path | None = None) -> pd.DataFrame:
    master_path = path or project_root() / "data" / "cards_master.csv"
    df = pd.read_csv(master_path, dtype=str, keep_default_na=False)
    validate_cards_master_schema(list(df.columns))
    return df


def write_output(rows: list[dict[str, str]], path: Path | None = None) -> Path:
    output_path = path or project_root() / "data" / "output.csv"
    df = pd.DataFrame(rows, columns=REQUIRED_OUTPUT_COLUMNS)
    validate_template_schema(list(df.columns))
    df.to_csv(output_path, index=False)
    return output_path
