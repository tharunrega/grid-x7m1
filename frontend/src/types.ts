export interface DecisionIntervalPoint {
  startTime: string;
  ukLocalTime: string;
  settlementPeriod: number;
  forecastGenerationMw: number | null;
  actualGenerationMw: number | null;
  publishTime: string | null;
  horizonHours: number | null;
  errorMw: number | null;
  absErrorMw: number | null;
  apePercent: number | null;
  candidatesAvailable: number;
  postCutoffExcluded: number;
}

export interface DeliveryDaySummary {
  deliveryDate: string;
  decisionCutoffTimeUk: string;
  decisionCutoffTimestampUtc: string;
  totalIntervals: number;
  matchedActualIntervals: number;
  meanForecastMw: number;
  meanActualMw: number | null;
  peakForecastMw: number;
  peakActualMw: number | null;
  minForecastMw: number;
  minActualMw: number | null;
  totalForecastEnergyMwh: number;
  totalActualEnergyMwh: number | null;
  latestPublishTimeUsed: string | null;
  earliestPublishTimeUsed: string | null;
  minHorizonHours: number | null;
  maxHorizonHours: number | null;
  meanHorizonHours: number | null;
  dayMaeMw: number | null;
  dayRmseMw: number | null;
  dayBiasMw: number | null;
  dayMapePercent: number | null;
  dayP90AbsErrorMw: number | null;
}

export interface DeliveryDayForecastResponse {
  summary: DeliveryDaySummary;
  intervals: DecisionIntervalPoint[];
  availableForecastRunsOnDMinus1: string[];
}

export interface MetricBundle {
  sampleCount: number;
  maeMw: number;
  rmseMw: number;
  biasMw: number;
  mapePercent: number;
  mapeGuardedCount: number;
  p50AbsErrorMw: number;
  p90AbsErrorMw: number;
  p95AbsErrorMw: number;
  meanForecastMw: number;
  meanActualMw: number;
}

export interface HorizonBreakdownRow {
  horizonBucket: string;
  minHorizonHours: number;
  maxHorizonHours: number;
  isDecisionWindow: boolean;
  metrics: MetricBundle;
}

export interface HourlyBreakdownRow {
  hour: number;
  hourLabel: string;
  metrics: MetricBundle;
}

export interface DailyBreakdownRow {
  deliveryDate: string;
  publishTimeUsed: string | null;
  meanHorizonHours: number;
  peakErrorMw: number;
  directionLabel: string;
  metrics: MetricBundle;
}

export interface ErrorHistogramBin {
  binLabel: string;
  binCenterMw: number;
  count: number;
}

export interface AccuracyReportResponse {
  startDate: string;
  endDate: string;
  decisionCutoffTimeUk: string;
  mapeGuardThresholdMw: number;
  overall: MetricBundle;
  coverageSummaryText: string;
  procurementGuidanceText: string;
  byHorizon: HorizonBreakdownRow[];
  byHourOfDay: HourlyBreakdownRow[];
  byDay: DailyBreakdownRow[];
  errorHistogram: ErrorHistogramBin[];
}
