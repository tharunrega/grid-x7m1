"""Local data cache & Elexon BMRS API client for FUELHH and WINDFOR streams.

Supports preloaded Parquet (`fuelhh_actuals.parquet`, `windfor_forecasts.parquet`)
and SQLite (`bmrs_cache.sqlite`) storage so the deployed application runs with zero
dependency on live external API availability, while providing a documented Elexon BMRS
stream ingestion function for refreshing or extending cache ranges.
"""

from __future__ import annotations

from pathlib import Path
import shutil
import sqlite3
import tempfile
from typing import Optional

import httpx
import pandas as pd

ELEXON_BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"
FUELHH_STREAM_URL = f"{ELEXON_BASE_URL}/datasets/FUELHH/stream"
WINDFOR_STREAM_URL = f"{ELEXON_BASE_URL}/datasets/WINDFOR/stream"

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class BmrsDataStore:
    """Manages local Parquet and SQLite caches for Elexon FUELHH and WINDFOR data."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.fuelhh_parquet = self.data_dir / "fuelhh_actuals.parquet"
        self.windfor_parquet = self.data_dir / "windfor_forecasts.parquet"
        self.sqlite_path = self.data_dir / "bmrs_cache.sqlite"
        self._fuelhh_df: Optional[pd.DataFrame] = None
        self._windfor_df: Optional[pd.DataFrame] = None

    def load_cached_data(self, prefer_format: str = "parquet") -> tuple[pd.DataFrame, pd.DataFrame]:
        """Load actuals (FUELHH WIND) and forecasts (WINDFOR) from local cache."""
        if self._fuelhh_df is not None and self._windfor_df is not None:
            return self._fuelhh_df, self._windfor_df

        if prefer_format == "parquet" and self.fuelhh_parquet.exists() and self.windfor_parquet.exists():
            self._fuelhh_df = pd.read_parquet(self.fuelhh_parquet)
            self._windfor_df = pd.read_parquet(self.windfor_parquet)
            return self._fuelhh_df, self._windfor_df

        if self.sqlite_path.exists():
            # Copy to /tmp before querying to guarantee lock-free reads on any container/FUSE mount
            with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
                tmp_path = Path(tmp.name)
            try:
                shutil.copy2(self.sqlite_path, tmp_path)
                with sqlite3.connect(tmp_path) as conn:
                    self._fuelhh_df = pd.read_sql_query("SELECT * FROM fuelhh_actuals ORDER BY startTime", conn)
                    self._windfor_df = pd.read_sql_query(
                        "SELECT * FROM windfor_forecasts ORDER BY startTime, publishTime", conn
                    )
                return self._fuelhh_df, self._windfor_df
            finally:
                tmp_path.unlink(missing_ok=True)

        raise FileNotFoundError(
            f"No preloaded cache found in {self.data_dir}. Expected {self.fuelhh_parquet} or {self.sqlite_path}."
        )

    def fetch_from_elexon_api(
        self,
        settlement_date_from: str = "2026-01-01",
        settlement_date_to: str = "2026-01-31",
        publish_from: str = "2025-12-15T00:00:00Z",
        publish_to: str = "2026-02-01T00:00:00Z",
        timeout_seconds: float = 30.0,
    ) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Fetch live Elexon BMRS FUELHH/stream (fuelType=WIND) and WINDFOR/stream data.

        Note: Forecasts are fetched from 2025-12-15T00:00:00Z so early-January delivery targets
        have full multi-day lookback coverage.
        """
        with httpx.Client(timeout=timeout_seconds) as client:
            fuel_resp = client.get(
                FUELHH_STREAM_URL,
                params={
                    "settlementDateFrom": settlement_date_from,
                    "settlementDateTo": settlement_date_to,
                    "fuelType": "WIND",
                },
            )
            fuel_resp.raise_for_status()
            fuel_records = [
                {
                    "dataset": row.get("dataset", "FUELHH"),
                    "publishTime": row.get("publishTime"),
                    "startTime": row["startTime"],
                    "settlementDate": row.get("settlementDate"),
                    "settlementPeriod": row.get("settlementPeriod"),
                    "fuelType": row.get("fuelType", "WIND"),
                    "generation": float(row["generation"]),
                }
                for row in fuel_resp.json()
                if row.get("fuelType", "WIND") == "WIND"
            ]

            wind_resp = client.get(
                WINDFOR_STREAM_URL,
                params={
                    "publishDateTimeFrom": publish_from,
                    "publishDateTimeTo": publish_to,
                },
            )
            wind_resp.raise_for_status()
            wind_records = [
                {
                    "dataset": row.get("dataset", "WINDFOR"),
                    "publishTime": row["publishTime"],
                    "startTime": row["startTime"],
                    "generation": float(row["generation"]),
                }
                for row in wind_resp.json()
            ]

        fuel_df = pd.DataFrame(fuel_records).sort_values("startTime").reset_index(drop=True)
        wind_df = pd.DataFrame(wind_records).sort_values(["startTime", "publishTime"]).reset_index(drop=True)
        return fuel_df, wind_df
