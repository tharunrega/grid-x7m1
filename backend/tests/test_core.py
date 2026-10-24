"""Unit and integration test suite for the UK Day-Ahead Wind Power Buying Portal.

Compatible with both `pytest` (`pytest backend/tests`) and standard library `unittest`
(`python3 -m unittest discover -s backend/tests -v`).

Covers:
1. Decision-cutoff latest-forecast selection (`publishTime <= cutoff_utc(D-1)`)
2. Strict exclusion of post-cutoff forecasts (`publishTime > cutoff_utc(D-1)`)
3. Exact boundary inclusion (`publishTime == cutoff_utc(D-1)`)
4. Early-January fallback to December 2025 forecasts (`2025-12-15` onwards)
5. Error definition (`error = forecast - actual`) and quantitative metrics (MAE, RMSE, Bias, P50/P90/P95)
6. Near-zero actual generation guard in MAPE calculation (0 MW and < 100 MW)
7. Breakdowns by horizon, hour of day, and delivery day + FastAPI endpoints & CSV export
"""

from __future__ import annotations

from datetime import datetime, timezone
import unittest

from fastapi.testclient import TestClient
import numpy as np
import pandas as pd

from backend.app.cutoff_selector import (
    compute_decision_cutoff_utc,
    select_delivery_day_forecasts_df,
    select_latest_forecast_for_target,
)
from backend.app.main import app
from backend.app.metrics import compute_metric_bundle, evaluate_accuracy_report


class TestCutoffForecastSelection(unittest.TestCase):
    """Tests for the D-1 decision cutoff forecast selection logic."""

    def test_compute_decision_cutoff_utc_january_gmt(self) -> None:
        # In January, UK time (Europe/London) is GMT (UTC+0).
        # Delivery day D = 2026-01-15, cutoff 09:00 UK -> 2026-01-14T09:00:00Z
        cutoff_dt = compute_decision_cutoff_utc("2026-01-15", "09:00")
        self.assertEqual(cutoff_dt, datetime(2026, 1, 14, 9, 0, 0, tzinfo=timezone.utc))

    def test_selects_latest_forecast_before_cutoff_and_excludes_after_cutoff(self) -> None:
        target = "2026-01-10T18:00:00Z"
        cutoff_utc = compute_decision_cutoff_utc("2026-01-10", "09:00")  # 2026-01-09T09:00:00Z

        candidates = [
            {"startTime": target, "publishTime": "2026-01-08T23:30:00Z", "generation": 9100},
            {"startTime": target, "publishTime": "2026-01-09T05:30:00Z", "generation": 9400},
            {"startTime": target, "publishTime": "2026-01-09T08:30:00Z", "generation": 9750},  # Should win
            {"startTime": target, "publishTime": "2026-01-09T10:30:00Z", "generation": 10200},  # After 09:00 cutoff!
            {"startTime": target, "publishTime": "2026-01-10T03:30:00Z", "generation": 10450},  # Intraday on D!
        ]

        selected, valid_count, excluded_count = select_latest_forecast_for_target(
            target_start_time=target,
            candidates=candidates,
            cutoff_utc=cutoff_utc,
        )

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected["publishTime"], "2026-01-09T08:30:00Z")
        self.assertEqual(selected["generation"], 9750)
        self.assertEqual(valid_count, 3)
        self.assertEqual(excluded_count, 2)

    def test_exact_cutoff_boundary_is_inclusive(self) -> None:
        target = "2026-01-05T12:00:00Z"
        cutoff_utc = compute_decision_cutoff_utc("2026-01-05", "08:30")  # 2026-01-04T08:30:00Z

        candidates = [
            {"startTime": target, "publishTime": "2026-01-04T05:30:00Z", "generation": 4100},
            {"startTime": target, "publishTime": "2026-01-04T08:30:00Z", "generation": 4350},  # Exact boundary
            {"startTime": target, "publishTime": "2026-01-04T08:30:01Z", "generation": 4900},  # 1s after cutoff
        ]

        selected, valid_count, excluded_count = select_latest_forecast_for_target(
            target_start_time=target,
            candidates=candidates,
            cutoff_utc=cutoff_utc,
        )
        assert selected is not None
        self.assertEqual(selected["publishTime"], "2026-01-04T08:30:00Z")
        self.assertEqual(selected["generation"], 4350)
        self.assertEqual(valid_count, 2)
        self.assertEqual(excluded_count, 1)

    def test_early_january_fallback_to_december_2025_forecasts(self) -> None:
        # Delivery day D = 2026-01-01, early cutoff 02:00 UK on 2025-12-31
        # If no D-1 run exists before 02:00, must fall back to earlier December 2025 forecast (>= 2025-12-15)
        windfor_df = pd.DataFrame(
            [
                {
                    "dataset": "WINDFOR",
                    "startTime": "2026-01-01T00:00:00Z",
                    "publishTime": "2025-12-15T08:30:00Z",
                    "generation": 11200,
                },
                {
                    "dataset": "WINDFOR",
                    "startTime": "2026-01-01T00:00:00Z",
                    "publishTime": "2025-12-31T08:30:00Z",
                    "generation": 11900,
                },
            ]
        )
        res_df = select_delivery_day_forecasts_df(
            delivery_date="2026-01-01",
            windfor_df=windfor_df,
            fuelhh_df=None,
            cutoff_time_uk="02:00",
        )
        first_row = res_df.iloc[0]
        self.assertEqual(first_row["publishTime"], "2025-12-15T08:30:00Z")
        self.assertEqual(first_row["forecastGenerationMw"], 11200)
        self.assertEqual(first_row["postCutoffExcluded"], 1)


class TestAccuracyMetricsAndMapeGuard(unittest.TestCase):
    """Tests for error = forecast - actual, MAE, RMSE, Bias, P50/P90/P95, and MAPE near-zero guard."""

    def test_exact_metric_values_and_error_sign(self) -> None:
        # Forecasts and actuals where error = forecast - actual:
        # Pair 1: F=1050, A=1000 -> error = +50
        # Pair 2: F=1900, A=2000 -> error = -100
        # Pair 3: F=3150, A=3000 -> error = +150
        # Pair 4: F=4200, A=4000 -> error = +200
        forecasts = [1050.0, 1900.0, 3150.0, 4200.0]
        actuals = [1000.0, 2000.0, 3000.0, 4000.0]
        # abs_errors = [50, 100, 150, 200] -> mean = 125.0
        # squared_errors = [2500, 10000, 22500, 40000] -> mean = 18750 -> sqrt = 136.9306...
        # signed_errors = [+50, -100, +150, +200] -> mean = +75.0
        # APEs = [5%, 5%, 5%, 5%] -> MAPE = 5.0%
        metrics = compute_metric_bundle(forecasts, actuals, mape_guard_mw=100.0)

        self.assertEqual(metrics.sampleCount, 4)
        self.assertAlmostEqual(metrics.maeMw, 125.0, places=2)
        self.assertAlmostEqual(metrics.rmseMw, 136.93, places=2)
        self.assertAlmostEqual(metrics.biasMw, 75.0, places=2)
        self.assertAlmostEqual(metrics.mapePercent, 5.0, places=2)
        self.assertEqual(metrics.mapeGuardedCount, 0)
        self.assertAlmostEqual(metrics.p50AbsErrorMw, float(np.percentile([50, 100, 150, 200], 50)), places=2)
        self.assertAlmostEqual(metrics.p90AbsErrorMw, float(np.percentile([50, 100, 150, 200], 90)), places=2)
        self.assertAlmostEqual(metrics.p95AbsErrorMw, float(np.percentile([50, 100, 150, 200], 95)), places=2)

    def test_mape_near_zero_guard_prevents_blowup_and_zero_division(self) -> None:
        # Include 0 MW and 25 MW actuals alongside normal 2000 MW actual
        forecasts = [450.0, 325.0, 2100.0]
        actuals = [0.0, 25.0, 2000.0]

        metrics = compute_metric_bundle(forecasts, actuals, mape_guard_mw=100.0)
        self.assertEqual(metrics.sampleCount, 3)
        self.assertEqual(metrics.mapeGuardedCount, 2)
        # Only the 3rd point (|2100 - 2000| / 2000 = 5.0%) passes the 100 MW guard
        self.assertAlmostEqual(metrics.mapePercent, 5.0, places=2)
        self.assertTrue(np.isfinite(metrics.mapePercent))


class TestFastApiEndpoints(unittest.TestCase):
    """Integration tests for FastAPI endpoints and CSV exports against preloaded January 2026 data."""

    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_endpoint(self) -> None:
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["fuelhhActualRows"], 1488)
        self.assertGreater(data["windforForecastRows"], 15000)

    def test_forecast_endpoint_and_cutoff_effect(self) -> None:
        resp_0900 = self.client.get("/api/forecast?delivery_date=2026-01-15&cutoff_time=09:00")
        self.assertEqual(resp_0900.status_code, 200)
        p_0900 = resp_0900.json()
        self.assertEqual(p_0900["summary"]["totalIntervals"], 48)
        self.assertEqual(p_0900["summary"]["latestPublishTimeUsed"], "2026-01-14T08:30:00Z")

        # Shifting cutoff earlier to 06:00 UK on D-1 must select the 05:30 run instead of 08:30
        resp_0600 = self.client.get("/api/forecast?delivery_date=2026-01-15&cutoff_time=06:00")
        self.assertEqual(resp_0600.status_code, 200)
        p_0600 = resp_0600.json()
        self.assertEqual(p_0600["summary"]["latestPublishTimeUsed"], "2026-01-14T05:30:00Z")
        self.assertGreater(
            p_0600["summary"]["meanHorizonHours"],
            p_0900["summary"]["meanHorizonHours"],
        )

    def test_accuracy_endpoint_and_csv_exports(self) -> None:
        resp = self.client.get("/api/accuracy?start_date=2026-01-01&end_date=2026-01-31&cutoff_time=09:00")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["overall"]["sampleCount"], 1488)
        self.assertIn("covers 90% of half-hourly outcomes", data["coverageSummaryText"])
        self.assertEqual(len(data["byHourOfDay"]), 24)
        self.assertEqual(len(data["byDay"]), 31)
        self.assertGreaterEqual(len(data["byHorizon"]), 2)

        csv_fc = self.client.get("/api/export/forecast.csv?delivery_date=2026-01-15&cutoff_time=09:00")
        self.assertEqual(csv_fc.status_code, 200)
        self.assertIn("text/csv", csv_fc.headers["content-type"])
        self.assertIn("forecastGenerationMw", csv_fc.text)

        csv_acc = self.client.get("/api/export/accuracy.csv?start_date=2026-01-01&end_date=2026-01-05&cutoff_time=09:00")
        self.assertEqual(csv_acc.status_code, 200)
        self.assertIn("errorMw", csv_acc.text)


if __name__ == "__main__":
    unittest.main()
