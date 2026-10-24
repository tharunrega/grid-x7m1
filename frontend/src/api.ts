import {
  AccuracyReportResponse,
  DeliveryDayForecastResponse,
} from './types';
import {
  evaluateAccuracyReportClient,
  selectDeliveryDayForecast,
} from './preloadedData';

const API_BASE = (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } })?.env?.VITE_API_BASE_URL || '';

export async function fetchDeliveryDayForecast(
  deliveryDate: string,
  cutoffTimeUk: string,
  mapeGuardMw: number = 100.0
): Promise<{ data: DeliveryDayForecastResponse; source: 'fastapi-backend' | 'preloaded-cache' }> {
  try {
    const params = new URLSearchParams({
      delivery_date: deliveryDate,
      cutoff_time: cutoffTimeUk,
      mape_guard_mw: String(mapeGuardMw),
    });
    const resp = await fetch(`${API_BASE}/api/forecast?${params.toString()}`);
    if (resp.ok) {
      const data = (await resp.json()) as DeliveryDayForecastResponse;
      return { data, source: 'fastapi-backend' };
    }
  } catch {
    // Fallback to deterministic preloaded cache when running static build
  }
  return {
    data: selectDeliveryDayForecast(deliveryDate, cutoffTimeUk, mapeGuardMw),
    source: 'preloaded-cache',
  };
}

export async function fetchAccuracyReport(
  startDate: string,
  endDate: string,
  cutoffTimeUk: string,
  mapeGuardMw: number = 100.0
): Promise<{ data: AccuracyReportResponse; source: 'fastapi-backend' | 'preloaded-cache' }> {
  try {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      cutoff_time: cutoffTimeUk,
      mape_guard_mw: String(mapeGuardMw),
    });
    const resp = await fetch(`${API_BASE}/api/accuracy?${params.toString()}`);
    if (resp.ok) {
      const data = (await resp.json()) as AccuracyReportResponse;
      return { data, source: 'fastapi-backend' };
    }
  } catch {
    // Fallback to deterministic preloaded cache when running static build
  }
  return {
    data: evaluateAccuracyReportClient(startDate, endDate, cutoffTimeUk, mapeGuardMw),
    source: 'preloaded-cache',
  };
}
