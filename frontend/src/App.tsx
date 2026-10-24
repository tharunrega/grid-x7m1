import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
} from 'lucide-react';
import { DecisionIntervalPoint } from './types';
import { evaluateAccuracyReportClient, selectDeliveryDayForecast } from './preloadedData';

type ActivePage = 'forecast' | 'accuracy' | 'methodology';
type AccuracyScope = 'month' | 'day';

const NOTABLE_DAYS: Array<{ date: string; label: string }> = [
  { date: '', label: 'Jump to day...' },
  { date: '2026-01-01', label: '1 Jan — New Year (Dec-15 forecast lookback)' },
  { date: '2026-01-05', label: '5 Jan — Cold snap low-wind trough (47.3 GW demand)' },
  { date: '2026-01-06', label: '6 Jan — Highest daily grid demand (901 GWh)' },
  { date: '2026-01-13', label: '13 Jan — Atlantic gale peak wind (17.4 GW)' },
  { date: '2026-01-15', label: '15 Jan — Mid-month benchmark delivery day' },
  { date: '2026-01-25', label: '25 Jan — Late-month winter storm ramp' },
];

const CUTOFF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '02:00', label: '02:00 UK' },
  { value: '06:00', label: '06:00 UK' },
  { value: '09:00', label: '09:00 UK' },
  { value: '11:00', label: '11:00 UK' },
  { value: '13:00', label: '13:00 UK' },
  { value: '17:00', label: '17:00 UK' },
  { value: '20:00', label: '20:00 UK' },
];

function formatShortDate(isoDate: string): string {
  const day = Number(isoDate.split('-')[2]) || 1;
  return `${day} Jan 2026`;
}

function formatPublishTimePlain(isoUtc: string | null): string {
  if (!isoUtc) return 'Unavailable';
  const day = Number(isoUtc.slice(8, 10));
  const month = isoUtc.slice(5, 7) === '12' ? 'Dec' : 'Jan';
  const time = isoUtc.slice(11, 16);
  return `${day} ${month}, ${time} UK`;
}

function triggerCsvDownload(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function App() {
  const [activePage, setActivePage] = useState<ActivePage>('forecast');
  const [deliveryDate, setDeliveryDate] = useState<string>('2026-01-15');
  const [cutoffTimeUk, setCutoffTimeUk] = useState<string>('09:00');
  const [accuracyScope, setAccuracyScope] = useState<AccuracyScope>('month');
  const [showCutoffTooltip, setShowCutoffTooltip] = useState<boolean>(false);
  const [isLoadingView, setIsLoadingView] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const notify = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  };

  const handleDateChange = (nextDate: string) => {
    if (!nextDate || nextDate < '2026-01-01' || nextDate > '2026-01-31') return;
    setIsLoadingView(true);
    setDeliveryDate(nextDate);
    window.setTimeout(() => setIsLoadingView(false), 90);
  };

  const forecastData = useMemo(
    () => selectDeliveryDayForecast(deliveryDate, cutoffTimeUk, 100),
    [deliveryDate, cutoffTimeUk]
  );

  const monthAccuracy = useMemo(
    () => evaluateAccuracyReportClient('2026-01-01', '2026-01-31', cutoffTimeUk, 100),
    [cutoffTimeUk]
  );

  const activeAccuracy = useMemo(() => {
    if (accuracyScope === 'day') {
      return evaluateAccuracyReportClient(deliveryDate, deliveryDate, cutoffTimeUk, 100);
    }
    return monthAccuracy;
  }, [accuracyScope, deliveryDate, cutoffTimeUk, monthAccuracy]);

  const p90BandMw = Math.round(monthAccuracy.overall.p90AbsErrorMw);

  // Build chart series and auto-scaled Y-axis domain with padding (not from 0)
  const { chartSeries, yDomain } = useMemo(() => {
    let minVal = Infinity;
    let maxVal = -Infinity;

    const series = forecastData.intervals.map((pt) => {
      const fc = pt.forecastGenerationMw ?? 0;
      const act = pt.actualGenerationMw ?? fc;
      const lower = Math.max(0, Math.round(fc - p90BandMw));
      const upper = Math.round(fc + p90BandMw);
      if (lower < minVal) minVal = lower;
      if (act < minVal) minVal = act;
      if (upper > maxVal) maxVal = upper;
      if (act > maxVal) maxVal = act;

      return {
        ...pt,
        p90LowerMw: lower,
        p90BandSpanMw: upper - lower,
        p90UpperMw: upper,
      };
    });

    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      return { chartSeries: series, yDomain: [0, 18000] as [number, number] };
    }

    const paddedMin = Math.max(0, Math.floor((minVal - 450) / 500) * 500);
    const paddedMax = Math.ceil((maxVal + 450) / 500) * 500;
    return { chartSeries: series, yDomain: [paddedMin, paddedMax] as [number, number] };
  }, [forecastData, p90BandMw]);

  const peakTimeLabel = useMemo(() => {
    let bestTime = '00:00';
    let bestVal = -1;
    for (const pt of forecastData.intervals) {
      if ((pt.forecastGenerationMw ?? 0) > bestVal) {
        bestVal = pt.forecastGenerationMw ?? 0;
        bestTime = pt.ukLocalTime;
      }
    }
    return bestTime;
  }, [forecastData]);

  const sevenDayRows = useMemo(() => {
    const dayNum = Number(deliveryDate.split('-')[2]) || 15;
    const startIdx = Math.max(0, Math.min(24, dayNum - 4));
    const weekdays = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
    return monthAccuracy.byDay.slice(startIdx, startIdx + 7).map((row) => {
      const dNum = Number(row.deliveryDate.slice(8, 10));
      const dow = weekdays[(dNum - 1) % 7];
      const dayDetail = selectDeliveryDayForecast(row.deliveryDate, cutoffTimeUk, 100);
      return {
        date: row.deliveryDate,
        label: `${dow} ${dNum} Jan`,
        minGw: dayDetail.summary.minForecastMw / 1000,
        maxGw: dayDetail.summary.peakForecastMw / 1000,
      };
    });
  }, [deliveryDate, monthAccuracy, cutoffTimeUk]);

  const worstDaysRows = useMemo(() => {
    return [...monthAccuracy.byDay].sort((a, b) => b.metrics.maeMw - a.metrics.maeMw);
  }, [monthAccuracy]);

  const handleExportCsv = () => {
    if (activePage === 'accuracy') {
      const headers = [
        'deliveryDate',
        'decisionCutoffTimeUk',
        'publishTimeUsed',
        'meanHorizonHours',
        'maeMw',
        'rmseMw',
        'biasMw',
        'mapePercent',
        'p90AbsErrorMw',
        'peakErrorMw',
        'directionLabel',
      ];
      const rows = monthAccuracy.byDay.map((d) =>
        [
          d.deliveryDate,
          monthAccuracy.decisionCutoffTimeUk,
          d.publishTimeUsed ?? '',
          d.meanHorizonHours,
          d.metrics.maeMw,
          d.metrics.rmseMw,
          d.metrics.biasMw,
          d.metrics.mapePercent,
          d.metrics.p90AbsErrorMw,
          d.peakErrorMw,
          d.directionLabel,
        ].join(',')
      );
      const fname = `wind_accuracy_jan2026_cutoff_${cutoffTimeUk.replace(':', '')}.csv`;
      triggerCsvDownload(fname, [headers.join(','), ...rows].join('\n'));
      notify(`Exported accuracy summary to ${fname}`);
      return;
    }

    const headers = [
      'deliveryDate',
      'decisionCutoffTimeUk',
      'timeUk',
      'startTimeUtc',
      'forecastMw',
      'actualMw',
      'errorMw',
      'publishTimeUtc',
      'horizonHours',
    ];
    const rows = forecastData.intervals.map((r) =>
      [
        forecastData.summary.deliveryDate,
        forecastData.summary.decisionCutoffTimeUk,
        r.ukLocalTime,
        r.startTime,
        r.forecastGenerationMw ?? '',
        r.actualGenerationMw ?? '',
        r.errorMw ?? '',
        r.publishTime ?? '',
        r.horizonHours ?? '',
      ].join(',')
    );
    const fname = `wind_forecast_${deliveryDate}_cutoff_${cutoffTimeUk.replace(':', '')}.csv`;
    triggerCsvDownload(fname, [headers.join(','), ...rows].join('\n'));
    notify(`Exported ${deliveryDate} forecast vs actuals to ${fname}`);
  };

  const biasValue = activeAccuracy.overall.biasMw;
  const biasDirectionText =
    biasValue > 20
      ? 'Slight over-forecast'
      : biasValue < -20
      ? 'Slight under-forecast'
      : 'Near-zero bias';
  const biasStatusStyle =
    Math.abs(biasValue) <= 50
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-amber-50 text-amber-800 border-amber-200';

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-page text-ink font-sans text-[14px] antialiased tabular-nums flex flex-col">
      {/* Theme Token CSS Rules for Canvas & Tailwind Compatibility */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .bg-page { background-color: #F4F6FA; }
        .bg-card { background-color: #FFFFFF; }
        .border-line { border-color: #E3E8F0; }
        .divide-line > :not([hidden]) ~ :not([hidden]) { border-color: #E3E8F0; }
        .text-ink { color: #18212F; }
        .text-muted { color: #566176; }
        .bg-ink { background-color: #18212F; }
        .bg-forecast { background-color: #1D5FD1; }
        .bg-forecast-soft { background-color: rgba(29, 95, 209, 0.10); }
        .text-forecast { color: #1D5FD1; }
        .border-forecast { border-color: #1D5FD1; }
        .text-actual { color: #C2410C; }
        .border-actual { border-color: #C2410C; }
        .rounded-card { border-radius: 16px; }
        .p-card { padding: 20px; }
        .gap-grid { gap: 16px; }
      `}</style>

      {/* ROW 1: Single-Line Header Bar */}
      <header className="bg-card border-b border-line px-4 xl:px-6 h-14 shrink-0 flex items-center">
        <div className="max-w-[1440px] w-full mx-auto flex flex-wrap lg:flex-nowrap items-center justify-between gap-2">
          {/* Left: Pill Navigation + Title */}
          <div className="flex items-center gap-4 min-w-0">
            <nav
              aria-label="Primary navigation"
              className="inline-flex items-center bg-page p-1 rounded-xl border border-line shrink-0"
            >
              <button
                type="button"
                onClick={() => setActivePage('forecast')}
                className={`px-3.5 py-1 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  activePage === 'forecast'
                    ? 'bg-ink text-white font-semibold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Forecast
              </button>
              <button
                type="button"
                onClick={() => setActivePage('accuracy')}
                className={`px-3.5 py-1 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  activePage === 'accuracy'
                    ? 'bg-ink text-white font-semibold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Accuracy
              </button>
              <button
                type="button"
                onClick={() => setActivePage('methodology')}
                className={`px-3.5 py-1 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  activePage === 'methodology'
                    ? 'bg-ink text-white font-semibold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Methodology
              </button>
            </nav>

            <h1 className="text-[16px] xl:text-[18px] font-semibold text-ink truncate">
              {activePage === 'forecast' && `Wind forecast for ${formatShortDate(deliveryDate)}`}
              {activePage === 'accuracy' && `Wind forecast for ${formatShortDate(deliveryDate)} — Accuracy`}
              {activePage === 'methodology' && 'Methodology & Elexon BMRS Definitions'}
            </h1>
          </div>

          {/* Right: Delivery-day picker, Cutoff-time dropdown, Jump to day dropdown, Export CSV button */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Delivery-day picker */}
            <div className="inline-flex items-center bg-page border border-line rounded-xl px-2 py-1 gap-1">
              <button
                type="button"
                aria-label="Previous delivery day"
                disabled={deliveryDate <= '2026-01-01'}
                onClick={() => {
                  const d = Number(deliveryDate.split('-')[2]) || 15;
                  if (d > 1) handleDateChange(`2026-01-${d - 1 < 10 ? `0${d - 1}` : d - 1}`);
                }}
                className="p-0.5 text-muted hover:text-ink disabled:opacity-30 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <label htmlFor="delivery-date-picker" className="sr-only">
                Delivery day
              </label>
              <input
                id="delivery-date-picker"
                type="date"
                min="2026-01-01"
                max="2026-01-31"
                value={deliveryDate}
                onChange={(e) => handleDateChange(e.target.value)}
                className="bg-transparent text-[13px] font-medium text-ink focus:outline-none"
              />
              <button
                type="button"
                aria-label="Next delivery day"
                disabled={deliveryDate >= '2026-01-31'}
                onClick={() => {
                  const d = Number(deliveryDate.split('-')[2]) || 15;
                  if (d < 31) handleDateChange(`2026-01-${d + 1 < 10 ? `0${d + 1}` : d + 1}`);
                }}
                className="p-0.5 text-muted hover:text-ink disabled:opacity-30 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Cutoff-time dropdown with info tooltip */}
            <div className="relative inline-flex items-center bg-page border border-line rounded-xl px-2.5 py-1 gap-1.5">
              <label htmlFor="cutoff-dropdown" className="text-[13px] text-muted">
                Cutoff:
              </label>
              <select
                id="cutoff-dropdown"
                value={cutoffTimeUk}
                onChange={(e) => setCutoffTimeUk(e.target.value)}
                className="bg-transparent text-[13px] font-semibold text-ink focus:outline-none"
              >
                {CUTOFF_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Only forecasts published before the cutoff are used"
                onClick={() => setShowCutoffTooltip((prev) => !prev)}
                onMouseEnter={() => setShowCutoffTooltip(true)}
                onMouseLeave={() => setShowCutoffTooltip(false)}
                className="text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
              {showCutoffTooltip && (
                <div
                  role="tooltip"
                  className="absolute top-full right-0 mt-2 w-64 p-2.5 rounded-xl bg-ink text-white text-[13px] leading-snug shadow-lg z-50"
                >
                  Only forecasts published before the cutoff are used.
                </div>
              )}
            </div>

            {/* Jump to day dropdown */}
            <div className="inline-flex items-center bg-page border border-line rounded-xl px-2.5 py-1">
              <label htmlFor="jump-day-dropdown" className="sr-only">
                Jump to notable day
              </label>
              <select
                id="jump-day-dropdown"
                value=""
                onChange={(e) => {
                  if (e.target.value) handleDateChange(e.target.value);
                }}
                className="bg-transparent text-[13px] font-medium text-muted hover:text-ink focus:outline-none max-w-[140px]"
              >
                {NOTABLE_DAYS.map((nd) => (
                  <option key={nd.label} value={nd.date}>
                    {nd.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Export CSV button */}
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-[13px] font-semibold bg-forecast hover:opacity-95 text-white transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-600"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>
      </header>

      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-xl bg-ink text-white text-[13px] font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}

      {/* MAIN CONTENT SHELL (flex-1 min-h-0, fits inside 1366x768 and 1440x900 with zero page vertical scroll) */}
      <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto p-4 flex flex-col gap-grid overflow-visible lg:overflow-hidden">
        {/* ==================== PAGE 1: FORECAST ==================== */}
        {activePage === 'forecast' && (
          <>
            {/* ROW 2: 4 KPI Cards */}
            <section
              aria-label="Key forecast summary metrics"
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-grid shrink-0"
            >
              {/* KPI 1: Peak forecast */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">Peak forecast</div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {forecastData.summary.peakForecastMw.toLocaleString()}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  At {peakTimeLabel} (Actual peak {forecastData.summary.peakActualMw?.toLocaleString() ?? '—'} MW)
                </div>
              </div>

              {/* KPI 2: Average forecast */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">Average forecast</div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {Math.round(forecastData.summary.meanForecastMw).toLocaleString()}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  Actual average:{' '}
                  {forecastData.summary.meanActualMw !== null
                    ? `${Math.round(forecastData.summary.meanActualMw).toLocaleString()} MW`
                    : 'Not available'}
                </div>
              </div>

              {/* KPI 3: Total energy (GWh) */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">Total energy (GWh)</div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {(forecastData.summary.totalForecastEnergyMwh / 1000).toFixed(1)}{' '}
                  <span className="text-[14px] font-medium text-muted">GWh</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  Actual outturn:{' '}
                  {forecastData.summary.totalActualEnergyMwh !== null
                    ? `${(forecastData.summary.totalActualEnergyMwh / 1000).toFixed(1)} GWh`
                    : 'Not available'}
                </div>
              </div>

              {/* KPI 4: Forecast used */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-muted">Forecast used</span>
                  <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Before cutoff
                  </span>
                </div>
                <div className="text-[22px] xl:text-[24px] leading-tight font-semibold text-ink mt-1 truncate">
                  {formatPublishTimePlain(forecastData.summary.latestPublishTimeUsed)}
                </div>
                <div className="text-[13px] text-muted mt-1">
                  Forecast made {forecastData.summary.minHorizonHours} to {forecastData.summary.maxHorizonHours} h ahead
                </div>
              </div>
            </section>

            {/* ROW 3: Fills Remaining Height (2 Columns: 8/12 Left Main Chart + Error Strip, 4/12 Right Insight + 7-Day List) */}
            <section className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-grid">
              {/* LEFT 8/12: Main Chart Card */}
              <div className="lg:col-span-8 bg-card rounded-card border border-line p-card flex flex-col min-h-0">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 shrink-0">
                  <div>
                    <h2 className="text-[15px] font-semibold text-ink">
                      Decision-time forecast vs. actual output (MW)
                    </h2>
                    <p className="text-[13px] text-muted">
                      Y-axis auto-scaled ({yDomain[0].toLocaleString()}–{yDomain[1].toLocaleString()} MW) so the gap between forecast and actual is clear
                    </p>
                  </div>

                  {/* Chart Legend */}
                  <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-4 h-0.5 bg-forecast inline-block" />
                      <span className="text-ink font-medium">Forecast</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-4 h-0.5 border-b-2 border-dashed border-actual inline-block" />
                      <span className="text-ink font-medium">Actual</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3.5 h-2.5 rounded-sm bg-forecast-soft border border-forecast inline-block" />
                      <span>Typical error range (90% of the time)</span>
                    </span>
                  </div>
                </div>

                {/* Top Main Line Chart */}
                {isLoadingView ? (
                  <div
                    aria-label="Loading forecast chart"
                    className="flex-1 min-h-[200px] lg:min-h-0 w-full rounded-xl bg-page animate-pulse"
                  />
                ) : chartSeries.length === 0 ? (
                  <div className="flex-1 min-h-[200px] lg:min-h-0 flex items-center justify-center text-[14px] text-muted">
                    No forecast intervals available for this date.
                  </div>
                ) : (
                  <div
                    aria-label="Decision-time forecast versus actual wind output chart"
                    className="flex-1 min-h-[200px] lg:min-h-0 w-full"
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={chartSeries}
                        syncId="forecastDaySync"
                        margin={{ top: 6, right: 12, left: 2, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#E3E8F0" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="ukLocalTime"
                          stroke="#566176"
                          tick={{ fontSize: 12, fill: '#566176' }}
                          tickLine={false}
                          axisLine={{ stroke: '#E3E8F0' }}
                          interval={5}
                        />
                        <YAxis
                          domain={yDomain}
                          allowDataOverflow={true}
                          stroke="#566176"
                          tick={{ fontSize: 12, fill: '#566176' }}
                          tickLine={false}
                          axisLine={false}
                          width={52}
                          tickFormatter={(v) => `${Number(v).toLocaleString()}`}
                        />
                        <Tooltip
                          content={({ active, payload }) => {
                            if (!active || !payload || !payload.length) return null;
                            const row = payload[0].payload as DecisionIntervalPoint;
                            const err = row.errorMw ?? 0;
                            return (
                              <div className="bg-card border border-line rounded-xl p-3 shadow-md text-[13px] space-y-1">
                                <div className="font-semibold text-ink border-b border-line pb-1">
                                  {row.ukLocalTime}
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted">Forecast:</span>
                                  <span className="font-semibold text-forecast">
                                    {row.forecastGenerationMw?.toLocaleString() ?? '—'} MW
                                  </span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted">Actual:</span>
                                  <span className="font-semibold text-actual">
                                    {row.actualGenerationMw?.toLocaleString() ?? '—'} MW
                                  </span>
                                </div>
                                <div className="flex justify-between gap-4 pt-0.5 border-t border-line">
                                  <span className="text-muted">Error:</span>
                                  <span className="font-semibold text-ink">
                                    {err > 0 ? `+${err.toLocaleString()}` : err.toLocaleString()} MW
                                  </span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        {/* Shaded uncertainty band at 14% opacity between p90LowerMw and p90UpperMw */}
                        <Area
                          type="monotone"
                          dataKey="p90LowerMw"
                          stackId="uncertaintyBand"
                          stroke="none"
                          fill="#FFFFFF"
                          fillOpacity={0}
                          activeDot={false}
                          isAnimationActive={false}
                        />
                        <Area
                          type="monotone"
                          dataKey="p90BandSpanMw"
                          stackId="uncertaintyBand"
                          stroke="none"
                          fill="#1D5FD1"
                          fillOpacity={0.14}
                          activeDot={false}
                          isAnimationActive={false}
                          name="Typical error range (90% of the time)"
                        />
                        {/* Forecast solid blue line (#1D5FD1, no area fill) */}
                        <Line
                          type="monotone"
                          dataKey="forecastGenerationMw"
                          name="Forecast"
                          stroke="#1D5FD1"
                          strokeWidth={2.25}
                          dot={false}
                          isAnimationActive={false}
                        />
                        {/* Actual dashed burnt-orange line (#C2410C, no area fill) */}
                        <Line
                          type="monotone"
                          dataKey="actualGenerationMw"
                          name="Actual"
                          stroke="#C2410C"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Slim Error-Bar Strip Below Sharing the X-Axis */}
                <div className="h-[88px] shrink-0 pt-2 border-t border-line flex flex-col">
                  <div className="flex items-center justify-between text-[12px] text-muted mb-0.5">
                    <span>Error (Forecast − Actual, MW)</span>
                    <span>Blue = over-forecast · Orange = under-forecast</span>
                  </div>
                  <div aria-label="Half-hourly forecast error strip chart" className="flex-1 min-h-0 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={chartSeries}
                        syncId="forecastDaySync"
                        margin={{ top: 2, right: 12, left: 2, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#E3E8F0" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="ukLocalTime"
                          stroke="#566176"
                          tick={{ fontSize: 11, fill: '#566176' }}
                          tickLine={false}
                          axisLine={{ stroke: '#E3E8F0' }}
                          interval={5}
                        />
                        <YAxis
                          stroke="#566176"
                          tick={{ fontSize: 11, fill: '#566176' }}
                          tickLine={false}
                          axisLine={false}
                          width={52}
                        />
                        <Tooltip content={() => null} />
                        <ReferenceLine y={0} stroke="#566176" strokeWidth={1} />
                        <Bar dataKey="errorMw" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                          {chartSeries.map((entry) => (
                            <Cell
                              key={entry.startTime}
                              fill={(entry.errorMw ?? 0) >= 0 ? '#1D5FD1' : '#C2410C'}
                              fillOpacity={0.75}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* RIGHT 4/12: Single Accent Insight Card + Compact 7-Day List */}
              <div className="lg:col-span-4 flex flex-col gap-grid min-h-0">
                {/* One Accent Insight Card */}
                <div
                  style={{
                    background: 'linear-gradient(135deg, #1D5FD1 0%, #15459B 100%)',
                  }}
                  className="rounded-card p-card text-white shrink-0 space-y-1"
                >
                  <div className="text-[13px] font-semibold uppercase tracking-wide text-blue-100">
                    Thermal procurement insight
                  </div>
                  <p className="text-[14px] leading-snug font-medium text-white">
                    Forecasts at this horizon landed within ±{p90BandMw.toLocaleString()} MW of actual output 90% of the time. Plan thermal cover around the lower edge of the band.
                  </p>
                </div>

                {/* Compact 7-Day List (Fills remaining height, scrolls internally only if needed) */}
                <div className="bg-card rounded-card border border-line p-card flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between pb-2 border-b border-line shrink-0">
                    <h2 className="text-[15px] font-semibold text-ink">7-day forecast range</h2>
                    <span className="text-[13px] text-muted">Min–Max GW</span>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-line pt-1">
                    {sevenDayRows.map((row) => {
                      const isSelected = row.date === deliveryDate;
                      const leftPct = Math.max(0, Math.min(75, Math.round((row.minGw / 18.5) * 100)));
                      const widthPct = Math.max(
                        10,
                        Math.min(100 - leftPct, Math.round(((row.maxGw - row.minGw) / 18.5) * 100))
                      );
                      return (
                        <button
                          key={row.date}
                          type="button"
                          onClick={() => handleDateChange(row.date)}
                          className={`w-full py-1.5 px-2 flex items-center justify-between gap-2 text-left rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                            isSelected ? 'bg-forecast-soft font-semibold' : 'hover:bg-page'
                          }`}
                        >
                          <span
                            className={`text-[13px] w-24 truncate ${
                              isSelected ? 'text-forecast font-semibold' : 'text-ink'
                            }`}
                          >
                            {row.label}
                          </span>
                          <span className="text-[13px] text-muted w-10 text-right">
                            {row.minGw.toFixed(1)}
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-page border border-line relative overflow-hidden mx-1">
                            <div
                              className="absolute top-0 bottom-0 rounded-full bg-forecast"
                              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            />
                          </div>
                          <span className="text-[13px] text-ink font-medium w-14 text-right">
                            {row.maxGw.toFixed(1)} GW
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ==================== PAGE 2: ACCURACY ==================== */}
        {activePage === 'accuracy' && (
          <>
            {/* ROW 1: 4 KPI Cards */}
            <section
              aria-label="Accuracy key performance indicators"
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-grid shrink-0"
            >
              {/* KPI 1: MAE */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">MAE (Mean absolute error)</div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {activeAccuracy.overall.maeMw.toLocaleString()}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  MAPE: {activeAccuracy.overall.mapePercent}% ({activeAccuracy.overall.sampleCount.toLocaleString()} periods)
                </div>
              </div>

              {/* KPI 2: RMSE */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">RMSE (Root mean squared error)</div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {activeAccuracy.overall.rmseMw.toLocaleString()}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  Penalizes large misses more heavily
                </div>
              </div>

              {/* KPI 3: Bias */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-muted">Bias (Forecast − Actual)</span>
                  <span className={`px-2 py-0.5 rounded-md text-[12px] font-medium border ${biasStatusStyle}`}>
                    {biasDirectionText}
                  </span>
                </div>
                <div className="text-[28px] leading-tight font-semibold text-ink mt-1">
                  {biasValue > 0 ? `+${biasValue}` : biasValue}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  {biasValue >= 0 ? 'Forecasts averaged above actual output' : 'Forecasts averaged below actual output'}
                </div>
              </div>

              {/* KPI 4: P90 error */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between">
                <div className="text-[13px] font-medium text-muted">P90 error</div>
                <div className="text-[28px] leading-tight font-semibold text-forecast mt-1">
                  ±{Math.round(activeAccuracy.overall.p90AbsErrorMw).toLocaleString()}{' '}
                  <span className="text-[14px] font-medium text-muted">MW</span>
                </div>
                <div className="text-[13px] text-muted mt-1">
                  9 in 10 misses are smaller (Median ±{Math.round(activeAccuracy.overall.p50AbsErrorMw)} MW)
                </div>
              </div>
            </section>

            {/* Single-line Insight Text + Segmented Period Switcher */}
            <div className="bg-card rounded-xl border border-line px-4 py-1.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <p className="text-[13px] text-ink font-medium truncate">
                Forecast ± {Math.round(activeAccuracy.overall.p90AbsErrorMw).toLocaleString()} MW covers 90% of outcomes at the {cutoffTimeUk} UK cutoff (P95 is ±{Math.round(activeAccuracy.overall.p95AbsErrorMw).toLocaleString()} MW).
              </p>

              <div
                role="group"
                aria-label="Switch accuracy evaluation period"
                className="inline-flex items-center bg-page p-0.5 rounded-lg border border-line shrink-0"
              >
                <button
                  type="button"
                  onClick={() => setAccuracyScope('month')}
                  className={`px-3 py-1 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                    accuracyScope === 'month'
                      ? 'bg-card text-ink font-semibold shadow-sm'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  Whole month
                </button>
                <button
                  type="button"
                  onClick={() => setAccuracyScope('day')}
                  className={`px-3 py-1 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                    accuracyScope === 'day'
                      ? 'bg-card text-ink font-semibold shadow-sm'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  Selected day ({formatShortDate(deliveryDate)})
                </button>
              </div>
            </div>

            {/* ROW 2: 2x2 Grid of Equal Cards (Fills Remaining Height) */}
            <section className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 lg:grid-rows-2 gap-grid">
              {/* Card 1: MAE by forecast horizon */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col min-h-0">
                <div className="flex items-center justify-between pb-1.5 shrink-0">
                  <h2 className="text-[14px] font-semibold text-ink">
                    MAE by forecast horizon (hours ahead)
                  </h2>
                  <span className="text-[13px] text-muted">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm bg-forecast mr-1.5 align-middle" />
                    Decision window
                  </span>
                </div>
                <div aria-label="MAE by forecast horizon chart" className="flex-1 min-h-[140px] lg:min-h-0 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={activeAccuracy.byHorizon.map((h) => ({
                        bucket: h.horizonBucket,
                        maeMw: h.metrics.maeMw,
                        isDecisionWindow: h.isDecisionWindow,
                      }))}
                      margin={{ top: 4, right: 10, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid stroke="#E3E8F0" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="bucket"
                        stroke="#566176"
                        tick={{ fontSize: 12, fill: '#566176' }}
                        tickLine={false}
                        axisLine={{ stroke: '#E3E8F0' }}
                      />
                      <YAxis
                        stroke="#566176"
                        tick={{ fontSize: 12, fill: '#566176' }}
                        tickLine={false}
                        axisLine={false}
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#E3E8F0',
                          borderRadius: '12px',
                          fontSize: '13px',
                        }}
                        formatter={(val: number) => [`${val} MW`, 'MAE']}
                      />
                      <Bar dataKey="maeMw" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {activeAccuracy.byHorizon.map((entry) => (
                          <Cell
                            key={entry.horizonBucket}
                            fill={entry.isDecisionWindow ? '#1D5FD1' : '#94A3B8'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Card 2: Error distribution histogram with zero line */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col min-h-0">
                <div className="flex items-center justify-between pb-1.5 shrink-0">
                  <h2 className="text-[14px] font-semibold text-ink">
                    Error distribution (Forecast − Actual, MW)
                  </h2>
                  <span className="text-[13px] text-muted">Dashed line = zero error</span>
                </div>
                <div aria-label="Error distribution histogram with zero line" className="flex-1 min-h-[140px] lg:min-h-0 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={activeAccuracy.errorHistogram}
                      margin={{ top: 4, right: 10, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid stroke="#E3E8F0" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="binLabel"
                        stroke="#566176"
                        tick={{ fontSize: 12, fill: '#566176' }}
                        tickLine={false}
                        axisLine={{ stroke: '#E3E8F0' }}
                      />
                      <YAxis
                        stroke="#566176"
                        tick={{ fontSize: 12, fill: '#566176' }}
                        tickLine={false}
                        axisLine={false}
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#E3E8F0',
                          borderRadius: '12px',
                          fontSize: '13px',
                        }}
                        formatter={(val: number) => [`${val} half-hours`, 'Periods']}
                      />
                      <ReferenceLine x="0" stroke="#C2410C" strokeWidth={2} strokeDasharray="4 3" />
                      <Bar dataKey="count" fill="#1D5FD1" fillOpacity={0.85} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Card 3: MAE by hour of day */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col min-h-0">
                <div className="flex items-center justify-between pb-1.5 shrink-0">
                  <h2 className="text-[14px] font-semibold text-ink">
                    MAE by hour of day (UK time)
                  </h2>
                  <span className="text-[13px] text-muted">00:00 to 23:00</span>
                </div>
                <div aria-label="MAE by hour of day bar chart" className="flex-1 min-h-[140px] lg:min-h-0 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={activeAccuracy.byHourOfDay.map((h) => ({
                        hourLabel: h.hourLabel,
                        maeMw: h.metrics.maeMw,
                      }))}
                      margin={{ top: 4, right: 10, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid stroke="#E3E8F0" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="hourLabel"
                        stroke="#566176"
                        tick={{ fontSize: 11, fill: '#566176' }}
                        tickLine={false}
                        axisLine={{ stroke: '#E3E8F0' }}
                        interval={2}
                      />
                      <YAxis
                        stroke="#566176"
                        tick={{ fontSize: 12, fill: '#566176' }}
                        tickLine={false}
                        axisLine={false}
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#E3E8F0',
                          borderRadius: '12px',
                          fontSize: '13px',
                        }}
                        formatter={(val: number) => [`${val} MW`, 'Hourly MAE']}
                      />
                      <Bar dataKey="maeMw" fill="#1D5FD1" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Card 4: Worst days table (scrolls internally) */}
              <div className="bg-card rounded-card border border-line p-card flex flex-col min-h-0">
                <div className="flex items-center justify-between pb-1.5 shrink-0">
                  <h2 className="text-[14px] font-semibold text-ink">
                    Worst days in January 2026 (by MAE)
                  </h2>
                  <span className="text-[13px] text-muted">Click a row to inspect</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto border border-line rounded-xl">
                  <table className="w-full text-left border-collapse text-[13px]">
                    <thead className="bg-page text-muted sticky top-0 border-b border-line">
                      <tr>
                        <th className="py-1.5 px-3 font-medium">Date</th>
                        <th className="py-1.5 px-3 font-medium text-right">MAE</th>
                        <th className="py-1.5 px-3 font-medium text-right">Peak miss</th>
                        <th className="py-1.5 px-3 font-medium">Direction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {worstDaysRows.map((row) => (
                        <tr
                          key={row.deliveryDate}
                          onClick={() => {
                            handleDateChange(row.deliveryDate);
                            setActivePage('forecast');
                          }}
                          className="hover:bg-page cursor-pointer transition-colors"
                        >
                          <td className="py-1.5 px-3 font-medium text-ink">
                            {formatShortDate(row.deliveryDate)}
                          </td>
                          <td className="py-1.5 px-3 text-right font-semibold text-forecast">
                            {Math.round(row.metrics.maeMw)} MW
                          </td>
                          <td className="py-1.5 px-3 text-right text-ink">
                            {row.peakErrorMw > 0 ? `+${Math.round(row.peakErrorMw)}` : Math.round(row.peakErrorMw)} MW
                          </td>
                          <td className="py-1.5 px-3">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-[12px] font-medium border ${
                                row.directionLabel === 'Over-forecast'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : row.directionLabel === 'Under-forecast'
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              }`}
                            >
                              {row.directionLabel}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ==================== PAGE 3: METHODOLOGY ==================== */}
        {activePage === 'methodology' && (
          <section className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-grid">
            {/* LEFT COLUMN: How the Decision-Time Forecast Is Chosen + Step Diagram */}
            <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between min-h-0 overflow-y-auto space-y-3">
              <div className="space-y-3">
                <h2 className="text-[16px] font-semibold text-ink">
                  How the decision-time forecast is chosen
                </h2>
                <p className="text-[14px] text-muted leading-relaxed">
                  Day-ahead power buyers submit their wholesale market bids on the day before delivery (D−1). To mirror real trading decisions without look-ahead bias, only forecasts published at or before the cutoff on the previous day are used.
                </p>

                {/* 4-Step Visual Diagram */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-page border border-line space-y-1">
                    <div className="text-[13px] font-semibold text-forecast">
                      1. Delivery day targets (Day D)
                    </div>
                    <p className="text-[13px] text-muted">
                      Each delivery day in January 2026 has 48 half-hourly target times from 00:00 to 23:30 UK time.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-page border border-line space-y-1">
                    <div className="text-[13px] font-semibold text-forecast">
                      2. Apply cutoff on D−1
                    </div>
                    <p className="text-[13px] text-muted">
                      Default decision cutoff is 09:00 UK time on D−1 ahead of morning day-ahead auction gate closure.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-page border border-line space-y-1">
                    <div className="text-[13px] font-semibold text-forecast">
                      3. Ignore post-cutoff updates
                    </div>
                    <p className="text-[13px] text-muted">
                      Forecasts published after {cutoffTimeUk} UK on D−1 are never used so accuracy reflects true trading risk.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-page border border-line space-y-1">
                    <div className="text-[13px] font-semibold text-forecast">
                      4. Choose latest eligible forecast
                    </div>
                    <p className="text-[13px] text-muted">
                      Among forecasts published at or before the cutoff (including mid-December runs for early Jan), the newest publish time wins.
                    </p>
                  </div>
                </div>
              </div>

              {/* Live D-1 Run Audit for Selected Day */}
              <div className="border-t border-line pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-ink">
                    D−1 forecast runs for {formatShortDate(deliveryDate)} (cutoff {cutoffTimeUk} UK)
                  </span>
                  <span className="text-[13px] text-muted">8 daily NGESO updates</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {forecastData.availableForecastRunsOnDMinus1.map((pubIso) => {
                    const isBefore = pubIso <= forecastData.summary.decisionCutoffTimestampUtc;
                    const isPicked = pubIso === forecastData.summary.latestPublishTimeUsed;
                    return (
                      <div
                        key={pubIso}
                        className={`px-2.5 py-1.5 rounded-lg border text-[13px] flex items-center justify-between ${
                          isPicked
                            ? 'bg-forecast-soft border-forecast text-forecast font-semibold'
                            : isBefore
                            ? 'bg-page border-line text-muted'
                            : 'bg-red-50 border-red-200 text-red-700'
                        }`}
                      >
                        <span>{pubIso.slice(11, 16)}</span>
                        <span className="text-[12px]">
                          {isPicked ? 'Chosen' : isBefore ? 'Older' : 'After cutoff'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Data Sources, Assumptions & Metric Definitions */}
            <div className="bg-card rounded-card border border-line p-card flex flex-col justify-between min-h-0 overflow-y-auto space-y-3">
              <div className="space-y-2">
                <h2 className="text-[16px] font-semibold text-ink">
                  Data sources &amp; assumptions
                </h2>
                <ul className="space-y-1.5 text-[13px] text-muted list-disc pl-4">
                  <li>
                    <strong className="text-ink">Actual wind output (FUELHH/stream):</strong> Half-hourly metered national wind generation (fuelType=WIND) from Elexon BMRS across all 1,488 half-hour periods in January 2026.
                  </li>
                  <li>
                    <strong className="text-ink">Wind forecasts (WINDFOR/stream):</strong> National wind forecasts published from 15 December 2025 through 31 January 2026 (23,098 records cached locally in Parquet and SQLite).
                  </li>
                  <li>
                    <strong className="text-ink">Time zone:</strong> January operates on GMT (UTC+0). Decision cutoffs are evaluated in UK local time (Europe/London).
                  </li>
                </ul>
              </div>

              <div className="border-t border-line pt-3 space-y-2">
                <h3 className="text-[15px] font-semibold text-ink">
                  Metric definitions
                </h3>
                <div className="grid grid-cols-1 gap-2 text-[13px]">
                  <div className="p-2.5 rounded-xl bg-page border border-line flex justify-between gap-4">
                    <strong className="text-ink shrink-0">Error (Forecast − Actual)</strong>
                    <span className="text-muted text-right">
                      Positive means wind was over-forecast (shortfall risk); negative means under-forecast.
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-page border border-line flex justify-between gap-4">
                    <strong className="text-ink shrink-0">MAE &amp; RMSE</strong>
                    <span className="text-muted text-right">
                      Average miss size in MW (MAE) and root-mean-squared miss (RMSE, which weights large spikes).
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-page border border-line flex justify-between gap-4">
                    <strong className="text-ink shrink-0">MAPE (near-zero guarded)</strong>
                    <span className="text-muted text-right">
                      Average percentage miss, guarding periods below 100 MW so calm wind hours do not divide by zero.
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-page border border-line flex justify-between gap-4">
                    <strong className="text-ink shrink-0">Typical error range (P90)</strong>
                    <span className="text-muted text-right">
                      9 in 10 misses are smaller than ±{p90BandMw} MW (used to size flexible thermal reserve cover).
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
