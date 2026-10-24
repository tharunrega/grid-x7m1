"""Pydantic data models for the UK Day-Ahead Wind Power Buying Portal API."""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


class ActualRecord(BaseModel):
    """Half-hourly actual wind generation record from Elexon BMRS FUELHH/stream."""

    dataset: str = Field(default="FUELHH", description="BMRS dataset identifier")
    startTime: str = Field(..., description="Target settlement period start time (ISO-8601 UTC)")
    publishTime: Optional[str] = Field(default=None, description="Publication timestamp (ISO-8601 UTC)")
    settlementDate: Optional[str] = Field(default=None, description="Settlement date YYYY-MM-DD")
    settlementPeriod: Optional[int] = Field(default=None, ge=1, le=50, description="Half-hourly settlement period (1-48)")
    fuelType: str = Field(default="WIND", description="Fuel type filter (always WIND)")
    generation: float = Field(..., description="Actual metered wind power generation in MW")


class ForecastRecord(BaseModel):
    """Wind generation forecast record from Elexon BMRS WINDFOR/stream."""

    dataset: str = Field(default="WINDFOR", description="BMRS dataset identifier")
    startTime: str = Field(..., description="Target settlement period start time (ISO-8601 UTC)")
    publishTime: str = Field(..., description="Forecast creation/publication time (ISO-8601 UTC)")
    generation: float = Field(..., description="Forecasted wind power generation in MW")


class DecisionIntervalPoint(BaseModel):
    """Aligned half-hourly decision-time wind forecast and actual outturn for a target startTime."""

    startTime: str = Field(..., description="Target half-hourly startTime (ISO-8601 UTC)")
    ukLocalTime: str = Field(..., description="UK local time label (HH:MM)")
    settlementPeriod: int = Field(..., ge=1, le=50, description="Settlement period index (1-48)")
    forecastGenerationMw: Optional[float] = Field(None, description="Selected decision-time forecast in MW")
    actualGenerationMw: Optional[float] = Field(None, description="Actual outturn generation in MW (if available)")
    publishTime: Optional[str] = Field(None, description="Publish timestamp of selected forecast (ISO-8601 UTC)")
    horizonHours: Optional[float] = Field(None, description="Lead time in hours between publishTime and startTime")
    errorMw: Optional[float] = Field(None, description="Signed error = forecast - actual (MW)")
    absErrorMw: Optional[float] = Field(None, description="Absolute error = |forecast - actual| (MW)")
    apePercent: Optional[float] = Field(None, description="Absolute percentage error (%) when actual >= guard threshold")
    candidatesAvailable: int = Field(0, description="Total forecasts available at or before decision cutoff")
    postCutoffExcluded: int = Field(0, description="Forecasts excluded because publishTime > decision cutoff")


class DeliveryDaySummary(BaseModel):
    """Summary KPIs for a single delivery day D under the chosen D-1 cutoff."""

    deliveryDate: str
    decisionCutoffTimeUk: str
    decisionCutoffTimestampUtc: str
    totalIntervals: int
    matchedActualIntervals: int
    meanForecastMw: float
    meanActualMw: Optional[float]
    peakForecastMw: float
    peakActualMw: Optional[float]
    minForecastMw: float
    minActualMw: Optional[float]
    totalForecastEnergyMwh: float
    totalActualEnergyMwh: Optional[float]
    latestPublishTimeUsed: Optional[str]
    earliestPublishTimeUsed: Optional[str]
    minHorizonHours: Optional[float]
    maxHorizonHours: Optional[float]
    meanHorizonHours: Optional[float]
    dayMaeMw: Optional[float]
    dayRmseMw: Optional[float]
    dayBiasMw: Optional[float]
    dayMapePercent: Optional[float]
    dayP90AbsErrorMw: Optional[float]


class DeliveryDayForecastResponse(BaseModel):
    """Full response payload for the Forecast page."""

    summary: DeliveryDaySummary
    intervals: list[DecisionIntervalPoint]
    availableForecastRunsOnDMinus1: list[str] = Field(
        default_factory=list,
        description="Distinct WINDFOR publishTime runs available around D-1 for inspection",
    )


class MetricBundle(BaseModel):
    """Standard quantitative error metrics where error = forecast - actual."""

    sampleCount: int = Field(..., description="Number of evaluated (forecast, actual) pairs")
    maeMw: float = Field(..., description="Mean Absolute Error in MW")
    rmseMw: float = Field(..., description="Root Mean Squared Error in MW")
    biasMw: float = Field(..., description="Mean Signed Error (forecast - actual) in MW")
    mapePercent: float = Field(..., description="Mean Absolute Percentage Error (%) with near-zero guard")
    mapeGuardedCount: int = Field(0, description="Count of near-zero actual intervals guarded/excluded in MAPE")
    p50AbsErrorMw: float = Field(..., description="Median (P50) absolute error in MW")
    p90AbsErrorMw: float = Field(..., description="90th percentile (P90) absolute error in MW")
    p95AbsErrorMw: float = Field(..., description="95th percentile (P95) absolute error in MW")
    meanForecastMw: float = Field(..., description="Average forecasted generation in MW")
    meanActualMw: float = Field(..., description="Average actual generation in MW")


class HorizonBreakdownRow(BaseModel):
    """Accuracy breakdown for a forecast lead-time horizon bucket."""

    horizonBucket: str
    minHorizonHours: float
    maxHorizonHours: float
    metrics: MetricBundle


class HourlyBreakdownRow(BaseModel):
    """Accuracy breakdown by UTC/UK hour of day (00:00 - 23:00)."""

    hour: int = Field(..., ge=0, le=23)
    hourLabel: str
    metrics: MetricBundle


class DailyBreakdownRow(BaseModel):
    """Accuracy breakdown by delivery date in January 2026."""

    deliveryDate: str
    publishTimeUsed: Optional[str]
    meanHorizonHours: float
    metrics: MetricBundle


class AccuracyReportResponse(BaseModel):
    """Full response payload for the Accuracy evaluation page."""

    startDate: str
    endDate: str
    decisionCutoffTimeUk: str
    mapeGuardThresholdMw: float
    overall: MetricBundle
    coverageSummaryText: str = Field(
        ...,
        description="Plain-language summary: 'Forecast ± X MW covers 90% of outcomes'",
    )
    procurementGuidanceText: str = Field(
        ...,
        description="Actionable day-ahead thermal procurement guidance derived from bias and P90 band",
    )
    byHorizon: list[HorizonBreakdownRow]
    byHourOfDay: list[HourlyBreakdownRow]
    byDay: list[DailyBreakdownRow]
