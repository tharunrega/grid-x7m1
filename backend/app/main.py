"""FastAPI application for the UK Energy Utility Day-Ahead Wind Power Buying Portal."""

from __future__ import annotations

from datetime import date, timedelta
import io
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from .cutoff_selector import (
    compute_decision_cutoff_utc,
    format_iso_utc,
    select_delivery_day_forecasts_df,
)
from .metrics import (
    DEFAULT_MAPE_GUARD_MW,
    build_multi_day_evaluation_df,
    compute_metric_bundle,
    evaluate_accuracy_report,
)
from .models import (
    AccuracyReportResponse,
    DecisionIntervalPoint,
    DeliveryDayForecastResponse,
    DeliveryDaySummary,
)
from .storage import BmrsDataStore

app = FastAPI(
    title="UK Day-Ahead Wind Power Buying Portal API",
    description=(
        "Decision-support API for UK wholesale day-ahead electricity buyers using Elexon BMRS "
        "FUELHH/stream (WIND actuals) and WINDFOR/stream (wind generation forecasts) for January 2026."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = BmrsDataStore()


def _validate_jan_2026_date(d_str: str, param_name: str = "date") -> date:
    try:
        dt = date.fromisoformat(d_str)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {param_name} '{d_str}'. Use YYYY-MM-DD.") from exc
    if not (date(2026, 1, 1) <= dt <= date(2026, 1, 31)):
        raise HTTPException(
            status_code=400,
            detail=f"{param_name} '{d_str}' is outside the scoped January 2026 delivery window (2026-01-01 to 2026-01-31).",
        )
    return dt


@app.get("/api/health")
def health_check() -> dict:
    """Health and preloaded cache status endpoint."""
    fuelhh_df, windfor_df = store.load_cached_data()
    return {
        "status": "ok",
        "scope": "January 2026 UK Day-Ahead Wind Procurement (Elexon BMRS)",
        "fuelhhActualRows": int(len(fuelhh_df)),
        "windforForecastRows": int(len(windfor_df)),
        "windforPublishRange": [
            str(windfor_df["publishTime"].min()),
            str(windfor_df["publishTime"].max()),
        ],
        "deliveryDateRange": ["2026-01-01", "2026-01-31"],
        "cacheFormats": {
            "parquet": store.fuelhh_parquet.exists() and store.windfor_parquet.exists(),
            "sqlite": store.sqlite_path.exists(),
        },
    }


@app.get("/api/forecast", response_model=DeliveryDayForecastResponse)
def get_delivery_day_forecast(
    delivery_date: str = Query("2026-01-15", description="Delivery day D in January 2026 (YYYY-MM-DD)"),
    cutoff_time: str = Query("09:00", description="Decision cutoff time on D-1 in UK time (HH:MM)"),
    mape_guard_mw: float = Query(DEFAULT_MAPE_GUARD_MW, ge=1.0, description="Near-zero guard threshold for APE (%)"),
) -> DeliveryDayForecastResponse:
    """Return decision-time wind forecast vs actuals for each 30-min interval on delivery day D."""
    d_dt = _validate_jan_2026_date(delivery_date, "delivery_date")
    try:
        cutoff_utc = compute_decision_cutoff_utc(d_dt, cutoff_time)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    fuelhh_df, windfor_df = store.load_cached_data()
    merged = select_delivery_day_forecasts_df(
        delivery_date=delivery_date,
        windfor_df=windfor_df,
        fuelhh_df=fuelhh_df,
        cutoff_time_uk=cutoff_time,
    )

    safe_guard = max(float(mape_guard_mw), 1e-6)
    intervals: list[DecisionIntervalPoint] = []
    for row in merged.to_dict(orient="records"):
        fc = None if pd.isna(row["forecastGenerationMw"]) else float(row["forecastGenerationMw"])
        act = None if pd.isna(row["actualGenerationMw"]) else float(row["actualGenerationMw"])
        err = None if (fc is None or act is None) else round(fc - act, 2)
        abs_err = None if err is None else round(abs(err), 2)
        ape = None
        if abs_err is not None and act is not None and abs(act) >= safe_guard:
            ape = round((abs_err / abs(act)) * 100.0, 2)

        intervals.append(
            DecisionIntervalPoint(
                startTime=str(row["startTime"]),
                ukLocalTime=str(row["ukLocalTime"]),
                settlementPeriod=int(row["settlementPeriod"]),
                forecastGenerationMw=fc,
                actualGenerationMw=act,
                publishTime=None if pd.isna(row["publishTime"]) else str(row["publishTime"]),
                horizonHours=None if pd.isna(row["horizonHours"]) else float(row["horizonHours"]),
                errorMw=err,
                absErrorMw=abs_err,
                apePercent=ape,
                candidatesAvailable=int(row["candidatesAvailable"]),
                postCutoffExcluded=int(row["postCutoffExcluded"]),
            )
        )

    matched = merged.dropna(subset=["forecastGenerationMw", "actualGenerationMw"])
    day_metrics = (
        compute_metric_bundle(
            matched["forecastGenerationMw"].to_numpy(),
            matched["actualGenerationMw"].to_numpy(),
            mape_guard_mw=mape_guard_mw,
        )
        if not matched.empty
        else None
    )

    fc_series = merged["forecastGenerationMw"].dropna()
    act_series = merged["actualGenerationMw"].dropna()
    pub_series = merged["publishTime"].dropna()
    hor_series = merged["horizonHours"].dropna()

    # Each half-hour settlement period = 0.5h, so Energy (MWh) = sum(MW * 0.5)
    summary = DeliveryDaySummary(
        deliveryDate=delivery_date,
        decisionCutoffTimeUk=cutoff_time,
        decisionCutoffTimestampUtc=format_iso_utc(cutoff_utc),
        totalIntervals=len(intervals),
        matchedActualIntervals=int(len(matched)),
        meanForecastMw=round(float(fc_series.mean()), 2) if not fc_series.empty else 0.0,
        meanActualMw=round(float(act_series.mean()), 2) if not act_series.empty else None,
        peakForecastMw=round(float(fc_series.max()), 2) if not fc_series.empty else 0.0,
        peakActualMw=round(float(act_series.max()), 2) if not act_series.empty else None,
        minForecastMw=round(float(fc_series.min()), 2) if not fc_series.empty else 0.0,
        minActualMw=round(float(act_series.min()), 2) if not act_series.empty else None,
        totalForecastEnergyMwh=round(float(fc_series.sum() * 0.5), 2) if not fc_series.empty else 0.0,
        totalActualEnergyMwh=round(float(act_series.sum() * 0.5), 2) if not act_series.empty else None,
        latestPublishTimeUsed=str(pub_series.max()) if not pub_series.empty else None,
        earliestPublishTimeUsed=str(pub_series.min()) if not pub_series.empty else None,
        minHorizonHours=round(float(hor_series.min()), 2) if not hor_series.empty else None,
        maxHorizonHours=round(float(hor_series.max()), 2) if not hor_series.empty else None,
        meanHorizonHours=round(float(hor_series.mean()), 2) if not hor_series.empty else None,
        dayMaeMw=day_metrics.maeMw if day_metrics else None,
        dayRmseMw=day_metrics.rmseMw if day_metrics else None,
        dayBiasMw=day_metrics.biasMw if day_metrics else None,
        dayMapePercent=day_metrics.mapePercent if day_metrics else None,
        dayP90AbsErrorMw=day_metrics.p90AbsErrorMw if day_metrics else None,
    )

    d_minus_1_str = (d_dt - timedelta(days=1)).isoformat()
    target_strs = merged["startTime"].tolist()
    d1_runs = sorted(
        windfor_df[
            windfor_df["startTime"].isin(target_strs)
            & windfor_df["publishTime"].str.startswith(d_minus_1_str)
        ]["publishTime"]
        .unique()
        .tolist()
    )

    return DeliveryDayForecastResponse(
        summary=summary,
        intervals=intervals,
        availableForecastRunsOnDMinus1=d1_runs,
    )


@app.get("/api/accuracy", response_model=AccuracyReportResponse)
def get_accuracy_report(
    start_date: str = Query("2026-01-01", description="Start delivery date in January 2026 (YYYY-MM-DD)"),
    end_date: str = Query("2026-01-31", description="End delivery date in January 2026 (YYYY-MM-DD)"),
    cutoff_time: str = Query("09:00", description="Decision cutoff time on D-1 in UK time (HH:MM)"),
    mape_guard_mw: float = Query(DEFAULT_MAPE_GUARD_MW, ge=1.0, description="Near-zero guard threshold for MAPE (MW)"),
) -> AccuracyReportResponse:
    """Return quantitative forecast accuracy metrics and breakdowns across [start_date, end_date]."""
    s_dt = _validate_jan_2026_date(start_date, "start_date")
    e_dt = _validate_jan_2026_date(end_date, "end_date")
    if e_dt < s_dt:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date.")
    try:
        compute_decision_cutoff_utc(s_dt, cutoff_time)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    fuelhh_df, windfor_df = store.load_cached_data()
    return evaluate_accuracy_report(
        start_date=start_date,
        end_date=end_date,
        windfor_df=windfor_df,
        fuelhh_df=fuelhh_df,
        cutoff_time_uk=cutoff_time,
        mape_guard_mw=mape_guard_mw,
    )


@app.get("/api/export/forecast.csv")
def export_forecast_csv(
    delivery_date: str = Query("2026-01-15"),
    cutoff_time: str = Query("09:00"),
) -> StreamingResponse:
    """Export the half-hourly decision-time forecast vs actuals table for delivery day D as CSV."""
    _validate_jan_2026_date(delivery_date, "delivery_date")
    fuelhh_df, windfor_df = store.load_cached_data()
    df = select_delivery_day_forecasts_df(
        delivery_date=delivery_date,
        windfor_df=windfor_df,
        fuelhh_df=fuelhh_df,
        cutoff_time_uk=cutoff_time,
    )
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    filename = f"uk_wind_forecast_{delivery_date}_cutoff_{cutoff_time.replace(':', '')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/accuracy.csv")
def export_accuracy_csv(
    start_date: str = Query("2026-01-01"),
    end_date: str = Query("2026-01-31"),
    cutoff_time: str = Query("09:00"),
    mape_guard_mw: float = Query(DEFAULT_MAPE_GUARD_MW, ge=1.0),
) -> StreamingResponse:
    """Export all evaluated half-hourly forecast vs actual error records across [start_date, end_date] as CSV."""
    _validate_jan_2026_date(start_date, "start_date")
    _validate_jan_2026_date(end_date, "end_date")
    fuelhh_df, windfor_df = store.load_cached_data()
    df = build_multi_day_evaluation_df(
        start_date=start_date,
        end_date=end_date,
        windfor_df=windfor_df,
        fuelhh_df=fuelhh_df,
        cutoff_time_uk=cutoff_time,
        mape_guard_mw=mape_guard_mw,
    )
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    filename = f"uk_wind_accuracy_{start_date}_to_{end_date}_cutoff_{cutoff_time.replace(':', '')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Mount built React frontend static assets in production Docker image if present
STATIC_DIST = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIST.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIST), html=True), name="static")
