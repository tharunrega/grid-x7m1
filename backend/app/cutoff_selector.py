"""Core decision-cutoff forecast selection logic for UK day-ahead power buying.

Rule:
For each target `startTime` on delivery day `D`, select the forecast from `WINDFOR`
with the latest `publishTime` at or before the configurable decision cutoff on `D-1`
(default 09:00 UK local time, Europe/London). Never use forecasts published after the cutoff.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

import pandas as pd

UK_TZ = ZoneInfo("Europe/London")


def parse_iso_utc(ts_str: str) -> datetime:
    """Parse an ISO-8601 timestamp string into a timezone-aware UTC datetime."""
    cleaned = ts_str.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def format_iso_utc(dt: datetime) -> str:
    """Format a timezone-aware datetime as canonical ISO-8601 UTC string (YYYY-MM-DDTHH:MM:SSZ)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def compute_decision_cutoff_utc(delivery_date: str | date, cutoff_time_uk: str = "09:00") -> datetime:
    """Compute the UTC decision cutoff timestamp on D-1 for a given delivery day D.

    Args:
        delivery_date: Delivery day D as 'YYYY-MM-DD' or `datetime.date`.
        cutoff_time_uk: Cutoff clock time on D-1 in UK local time ('HH:MM' or 'HH:MM:SS').

    Returns:
        Timezone-aware UTC `datetime` representing `D-1` at `cutoff_time_uk` (Europe/London).
    """
    if isinstance(delivery_date, str):
        d_date = date.fromisoformat(delivery_date)
    else:
        d_date = delivery_date

    parts = [int(p) for p in cutoff_time_uk.strip().split(":")]
    if len(parts) == 2:
        cutoff_clock = time(parts[0], parts[1], 0)
    elif len(parts) == 3:
        cutoff_clock = time(parts[0], parts[1], parts[2])
    else:
        raise ValueError(f"Invalid cutoff_time_uk format: {cutoff_time_uk!r}. Expected 'HH:MM'.")

    decision_date = d_date - timedelta(days=1)
    uk_local_dt = datetime.combine(decision_date, cutoff_clock, tzinfo=UK_TZ)
    return uk_local_dt.astimezone(timezone.utc)


def select_latest_forecast_for_target(
    target_start_time: str | datetime,
    candidates: Iterable[dict],
    cutoff_utc: datetime,
) -> tuple[Optional[dict], int, int]:
    """Select the single forecast with the latest publishTime <= cutoff_utc for a target startTime.

    Strictly enforces:
    1. `candidate.startTime == target_start_time`
    2. `candidate.publishTime <= cutoff_utc` (never uses forecasts published after cutoff)
    3. `candidate.publishTime <= target_start_time` (physical causality guard)

    Returns:
        Tuple of (selected_candidate_or_None, valid_candidate_count, post_cutoff_excluded_count)
    """
    target_dt = parse_iso_utc(target_start_time) if isinstance(target_start_time, str) else target_start_time.astimezone(timezone.utc)
    cutoff_dt = cutoff_utc.astimezone(timezone.utc)

    best_record: Optional[dict] = None
    best_pub_dt: Optional[datetime] = None
    valid_count = 0
    excluded_after_cutoff = 0

    for row in candidates:
        row_start_dt = parse_iso_utc(str(row["startTime"]))
        if row_start_dt != target_dt:
            continue

        pub_dt = parse_iso_utc(str(row["publishTime"]))
        if pub_dt > cutoff_dt:
            excluded_after_cutoff += 1
            continue
        if pub_dt > target_dt:
            excluded_after_cutoff += 1
            continue

        valid_count += 1
        if best_pub_dt is None or pub_dt > best_pub_dt:
            best_pub_dt = pub_dt
            best_record = row

    return best_record, valid_count, excluded_after_cutoff


def select_delivery_day_forecasts_df(
    delivery_date: str,
    windfor_df: pd.DataFrame,
    fuelhh_df: Optional[pd.DataFrame] = None,
    cutoff_time_uk: str = "09:00",
) -> pd.DataFrame:
    """Vectorized selection of decision-time forecasts for all 48 half-hour targets on delivery day D.

    For each half-hourly target `startTime` on delivery day `D`, chooses the forecast in
    `windfor_df` with the maximum `publishTime` where `publishTime <= cutoff_utc(D-1)`.
    """
    d_date = date.fromisoformat(delivery_date)
    day_start_utc = datetime(d_date.year, d_date.month, d_date.day, 0, 0, tzinfo=timezone.utc)
    target_dts = [day_start_utc + timedelta(minutes=30 * i) for i in range(48)]
    target_strs = [format_iso_utc(dt) for dt in target_dts]

    cutoff_utc = compute_decision_cutoff_utc(d_date, cutoff_time_uk)
    cutoff_str = format_iso_utc(cutoff_utc)

    # Filter WINDFOR to target day startTimes
    day_wf = windfor_df[windfor_df["startTime"].isin(target_strs)].copy()

    # Count post-cutoff forecasts per startTime (strictly excluded)
    post_cutoff_mask = day_wf["publishTime"] > cutoff_str
    excluded_counts = day_wf[post_cutoff_mask].groupby("startTime").size().to_dict()

    # Keep only eligible forecasts published at or before cutoff_utc
    eligible_wf = day_wf[~post_cutoff_mask & (day_wf["publishTime"] <= day_wf["startTime"])].copy()
    valid_counts = eligible_wf.groupby("startTime").size().to_dict()

    # Sort by (startTime, publishTime) and take the last (latest publishTime) per startTime
    if not eligible_wf.empty:
        selected_wf = (
            eligible_wf.sort_values(["startTime", "publishTime"])
            .groupby("startTime", as_index=False)
            .last()[["startTime", "publishTime", "generation"]]
            .rename(columns={"generation": "forecastGenerationMw"})
        )
    else:
        selected_wf = pd.DataFrame(columns=["startTime", "publishTime", "forecastGenerationMw"])

    grid_df = pd.DataFrame(
        {
            "startTime": target_strs,
            "settlementPeriod": list(range(1, 49)),
            "ukLocalTime": [dt.astimezone(UK_TZ).strftime("%H:%M") for dt in target_dts],
        }
    )

    merged = grid_df.merge(selected_wf, on="startTime", how="left")

    if fuelhh_df is not None and not fuelhh_df.empty:
        day_act = (
            fuelhh_df[fuelhh_df["startTime"].isin(target_strs)][["startTime", "generation"]]
            .drop_duplicates(subset=["startTime"], keep="last")
            .rename(columns={"generation": "actualGenerationMw"})
        )
        merged = merged.merge(day_act, on="startTime", how="left")
    else:
        merged["actualGenerationMw"] = None

    # Compute horizonHours and error = forecast - actual
    horizons: list[Optional[float]] = []
    for st_val, pub_val in zip(merged["startTime"], merged["publishTime"]):
        if pd.isna(pub_val) or not pub_val:
            horizons.append(None)
        else:
            st_dt = parse_iso_utc(str(st_val))
            pb_dt = parse_iso_utc(str(pub_val))
            horizons.append(round((st_dt - pb_dt).total_seconds() / 3600.0, 2))

    merged["horizonHours"] = horizons
    merged["decisionCutoffUtc"] = cutoff_str
    merged["deliveryDate"] = delivery_date
    merged["candidatesAvailable"] = [int(valid_counts.get(st, 0)) for st in merged["startTime"]]
    merged["postCutoffExcluded"] = [int(excluded_counts.get(st, 0)) for st in merged["startTime"]]

    # Signed error = forecast - actual
    merged["errorMw"] = merged["forecastGenerationMw"] - merged["actualGenerationMw"]
    merged["absErrorMw"] = merged["errorMw"].abs()

    return merged
