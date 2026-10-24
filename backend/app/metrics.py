"""Quantitative forecast accuracy metrics and breakdowns for UK wind power procurement.

Implements:
- Error definition: `error = forecast - actual` (MW)
- MAE, RMSE, signed Bias, MAPE (with configurable near-zero actual generation guard)
- P50, P90, and P95 absolute error percentiles
- Plain-language 90% coverage summary ("Forecast ± X MW covers 90% of outcomes")
- Breakdowns by forecast horizon bucket, hour of day (0-23), and delivery day
"""

from __future__ import annotations

from datetime import date, timedelta
import math
from typing import Optional

import numpy as np
import pandas as pd

from .cutoff_selector import parse_iso_utc, select_delivery_day_forecasts_df
from .models import (
    AccuracyReportResponse,
    DailyBreakdownRow,
    HorizonBreakdownRow,
    HourlyBreakdownRow,
    MetricBundle,
)

DEFAULT_MAPE_GUARD_MW = 100.0

HORIZON_BUCKETS: list[tuple[str, float, float]] = [
    ("12–18h (Early Morning D)", 0.0, 18.0),
    ("18–24h (Morning / Midday D)", 18.0, 24.0),
    ("24–30h (Afternoon / Evening D)", 24.0, 30.0),
    ("30–36h (Late Evening D)", 30.0, 36.0),
    (">36h (Extended Lookback)", 36.0, 1000.0),
]


def compute_metric_bundle(
    forecasts: np.ndarray | list[float],
    actuals: np.ndarray | list[float],
    mape_guard_mw: float = DEFAULT_MAPE_GUARD_MW,
) -> MetricBundle:
    """Compute MAE, RMSE, Bias, guarded MAPE, and P50/P90/P95 absolute error.

    Args:
        forecasts: Array-like of forecasted generation values (MW).
        actuals: Array-like of actual generation values (MW).
        mape_guard_mw: Minimum actual generation (MW) required to include a point in standard
            percentage error, guarding against division by zero or extreme blow-up near 0 MW.

    Returns:
        `MetricBundle` with rounded quantitative accuracy indicators.
    """
    f_arr = np.asarray(forecasts, dtype=float)
    a_arr = np.asarray(actuals, dtype=float)

    valid_mask = ~(np.isnan(f_arr) | np.isnan(a_arr))
    f_clean = f_arr[valid_mask]
    a_clean = a_arr[valid_mask]

    n = int(len(f_clean))
    if n == 0:
        return MetricBundle(
            sampleCount=0,
            maeMw=0.0,
            rmseMw=0.0,
            biasMw=0.0,
            mapePercent=0.0,
            mapeGuardedCount=0,
            p50AbsErrorMw=0.0,
            p90AbsErrorMw=0.0,
            p95AbsErrorMw=0.0,
            meanForecastMw=0.0,
            meanActualMw=0.0,
        )

    # Core error definition: error = forecast - actual
    errors = f_clean - a_clean
    abs_errors = np.abs(errors)

    mae = float(np.mean(abs_errors))
    rmse = float(math.sqrt(float(np.mean(errors ** 2))))
    bias = float(np.mean(errors))

    # Guard against near-zero actuals when computing MAPE:
    # Points with |actual| < max(mape_guard_mw, 1e-6) are flagged as guarded and excluded from the denominator
    # (or if all points are below the guard, fall back to clamping the denominator at max(mape_guard_mw, 1.0)).
    safe_threshold = max(float(mape_guard_mw), 1e-6)
    above_guard_mask = np.abs(a_clean) >= safe_threshold
    guarded_count = int(np.sum(~above_guard_mask))

    if np.any(above_guard_mask):
        mape = float(np.mean(abs_errors[above_guard_mask] / np.abs(a_clean[above_guard_mask])) * 100.0)
    else:
        clamped_denom = np.maximum(np.abs(a_clean), safe_threshold)
        mape = float(np.mean(abs_errors / clamped_denom) * 100.0)

    p50 = float(np.percentile(abs_errors, 50))
    p90 = float(np.percentile(abs_errors, 90))
    p95 = float(np.percentile(abs_errors, 95))

    return MetricBundle(
        sampleCount=n,
        maeMw=round(mae, 2),
        rmseMw=round(rmse, 2),
        biasMw=round(bias, 2),
        mapePercent=round(mape, 2),
        mapeGuardedCount=guarded_count,
        p50AbsErrorMw=round(p50, 2),
        p90AbsErrorMw=round(p90, 2),
        p95AbsErrorMw=round(p95, 2),
        meanForecastMw=round(float(np.mean(f_clean)), 2),
        meanActualMw=round(float(np.mean(a_clean)), 2),
    )


def build_multi_day_evaluation_df(
    start_date: str,
    end_date: str,
    windfor_df: pd.DataFrame,
    fuelhh_df: pd.DataFrame,
    cutoff_time_uk: str = "09:00",
    mape_guard_mw: float = DEFAULT_MAPE_GUARD_MW,
) -> pd.DataFrame:
    """Build combined decision-time evaluation dataframe across a date range [start_date, end_date]."""
    s_dt = date.fromisoformat(start_date)
    e_dt = date.fromisoformat(end_date)
    if e_dt < s_dt:
        raise ValueError(f"end_date ({end_date}) must be >= start_date ({start_date})")

    daily_frames: list[pd.DataFrame] = []
    cur = s_dt
    while cur <= e_dt:
        d_str = cur.isoformat()
        day_df = select_delivery_day_forecasts_df(
            delivery_date=d_str,
            windfor_df=windfor_df,
            fuelhh_df=fuelhh_df,
            cutoff_time_uk=cutoff_time_uk,
        )
        daily_frames.append(day_df)
        cur += timedelta(days=1)

    if not daily_frames:
        return pd.DataFrame()

    all_df = pd.concat(daily_frames, ignore_index=True)
    # Add hour of day (UTC) and guarded APE (%)
    all_df["hourOfDay"] = [parse_iso_utc(st).hour for st in all_df["startTime"]]

    safe_guard = max(float(mape_guard_mw), 1e-6)
    ape_vals: list[Optional[float]] = []
    for fc, act in zip(all_df["forecastGenerationMw"], all_df["actualGenerationMw"]):
        if pd.isna(fc) or pd.isna(act) or abs(float(act)) < safe_guard:
            ape_vals.append(None)
        else:
            ape_vals.append(round(abs(float(fc) - float(act)) / abs(float(act)) * 100.0, 2))
    all_df["apePercent"] = ape_vals
    return all_df


def evaluate_accuracy_report(
    start_date: str,
    end_date: str,
    windfor_df: pd.DataFrame,
    fuelhh_df: pd.DataFrame,
    cutoff_time_uk: str = "09:00",
    mape_guard_mw: float = DEFAULT_MAPE_GUARD_MW,
) -> AccuracyReportResponse:
    """Compute overall metrics, 90% coverage summary, and breakdowns by horizon, hour, and day."""
    eval_df = build_multi_day_evaluation_df(
        start_date=start_date,
        end_date=end_date,
        windfor_df=windfor_df,
        fuelhh_df=fuelhh_df,
        cutoff_time_uk=cutoff_time_uk,
        mape_guard_mw=mape_guard_mw,
    )

    matched_df = eval_df.dropna(subset=["forecastGenerationMw", "actualGenerationMw"]).copy()

    overall_metrics = compute_metric_bundle(
        matched_df["forecastGenerationMw"].to_numpy(),
        matched_df["actualGenerationMw"].to_numpy(),
        mape_guard_mw=mape_guard_mw,
    )

    p90_band = round(overall_metrics.p90AbsErrorMw)
    p50_band = round(overall_metrics.p50AbsErrorMw)
    bias_dir = "over-forecasts" if overall_metrics.biasMw >= 0 else "under-forecasts"
    bias_abs = abs(round(overall_metrics.biasMw))

    coverage_summary = (
        f"Forecast ± {p90_band:,} MW covers 90% of half-hourly outcomes "
        f"(median error ± {p50_band:,} MW; P95 ± {round(overall_metrics.p95AbsErrorMw):,} MW)."
    )
    procurement_guidance = (
        f"At the {cutoff_time_uk} UK D-1 decision cutoff, WINDFOR {bias_dir} actual wind generation by "
        f"{bias_abs:,} MW on average (Bias = {overall_metrics.biasMw:+.1f} MW, MAE = {overall_metrics.maeMw:,.1f} MW). "
        f"Day-ahead traders procuring residual thermal capacity should apply a {p90_band:,} MW 90%-confidence "
        f"headroom buffer to protect against wind shortfall risk."
    )

    # 1. Breakdown by forecast horizon
    by_horizon: list[HorizonBreakdownRow] = []
    for label, h_min, h_max in HORIZON_BUCKETS:
        if h_max >= 1000.0:
            sub = matched_df[matched_df["horizonHours"] > h_min]
        elif h_min == 0.0:
            sub = matched_df[matched_df["horizonHours"] <= h_max]
        else:
            sub = matched_df[(matched_df["horizonHours"] > h_min) & (matched_df["horizonHours"] <= h_max)]

        if not sub.empty:
            by_horizon.append(
                HorizonBreakdownRow(
                    horizonBucket=label,
                    minHorizonHours=round(float(sub["horizonHours"].min()), 2),
                    maxHorizonHours=round(float(sub["horizonHours"].max()), 2),
                    metrics=compute_metric_bundle(
                        sub["forecastGenerationMw"].to_numpy(),
                        sub["actualGenerationMw"].to_numpy(),
                        mape_guard_mw=mape_guard_mw,
                    ),
                )
            )

    # 2. Breakdown by hour of day (0..23)
    by_hour: list[HourlyBreakdownRow] = []
    for hr in range(24):
        sub = matched_df[matched_df["hourOfDay"] == hr]
        if not sub.empty:
            by_hour.append(
                HourlyBreakdownRow(
                    hour=hr,
                    hourLabel=f"{hr:02d}:00",
                    metrics=compute_metric_bundle(
                        sub["forecastGenerationMw"].to_numpy(),
                        sub["actualGenerationMw"].to_numpy(),
                        mape_guard_mw=mape_guard_mw,
                    ),
                )
            )

    # 3. Breakdown by delivery day
    by_day: list[DailyBreakdownRow] = []
    for d_date, sub in matched_df.groupby("deliveryDate", sort=True):
        pubs = sub["publishTime"].dropna().unique()
        latest_pub = str(sorted(pubs)[-1]) if len(pubs) > 0 else None
        mean_h = round(float(sub["horizonHours"].mean()), 2) if not sub["horizonHours"].dropna().empty else 0.0
        by_day.append(
            DailyBreakdownRow(
                deliveryDate=str(d_date),
                publishTimeUsed=latest_pub,
                meanHorizonHours=mean_h,
                metrics=compute_metric_bundle(
                    sub["forecastGenerationMw"].to_numpy(),
                    sub["actualGenerationMw"].to_numpy(),
                    mape_guard_mw=mape_guard_mw,
                ),
            )
        )

    return AccuracyReportResponse(
        startDate=start_date,
        endDate=end_date,
        decisionCutoffTimeUk=cutoff_time_uk,
        mapeGuardThresholdMw=mape_guard_mw,
        overall=overall_metrics,
        coverageSummaryText=coverage_summary,
        procurementGuidanceText=procurement_guidance,
        byHorizon=by_horizon,
        byHourOfDay=by_hour,
        byDay=by_day,
    )
