# UK Day-Ahead Wind Power Buying Portal (Elexon BMRS · January 2026)

Decision-support web application built for a UK energy utility’s **day-ahead wholesale power buying desk**. The portal ingests half-hourly national wind generation actuals (`FUELHH/stream`, `fuelType=WIND`) and multi-horizon wind generation forecasts (`WINDFOR/stream`) from the [Elexon BMRS Insights Solution API](https://bmrs.elexon.co.uk/api-documentation) to answer two operational questions before day-ahead auction gate closure on day `D-1`:

1. **What is the latest causal wind generation forecast available at our decision cutoff on `D-1` (default `09:00` UK time) for each half-hourly settlement period on delivery day `D`?**
2. **How accurate are those decision-time forecasts quantitatively (`error = forecast − actual`), and how much flexible thermal reserve headroom (`± X MW`) is required to cover 90% of half-hourly wind deviations?**

---

## Explicit AI Tool Usage Disclosure

> **AI Assistance Disclosure:** In accordance with the project specification, AI coding and analytical tools (Google Gemini) were used to assist with scaffolding the FastAPI + Pydantic backend, designing the React + TypeScript + Recharts user interface, writing unit and integration tests for the `D-1` cutoff selector and guarded MAPE calculations, and structuring this documentation. All domain rules, cutoff causality guards, and metric formulas were deterministically verified against automated test suites.

---

## Deployed Application & Live Preview

- **Interactive Canvas Web App:** `uk_wind_power_buying_portal.tsx` (self-contained React + TypeScript application preloaded with the complete January 2026 Elexon BMRS dataset, rendered directly in Canvas).
- **Reference Cloud Deployment URL (Vercel / Heroku Target):** `https://uk-wind-buying-portal-jan2026.vercel.app` (configured via included `vercel.json`, `Procfile`, and multi-stage `Dockerfile` so the app deploys in one command without requiring live external API calls).

---

## Directory Layout

```text
uk-wind-power-buying-portal/
├── Dockerfile                        # Multi-stage build (Node 20 Alpine -> Python 3.11 Slim)
├── docker-compose.yml                # Local full-stack orchestration (FastAPI :8000 + Vite :5173)
├── vercel.json                       # One-click Vercel full-stack deployment config
├── Procfile                          # Heroku container/web dyno process specification
├── .dockerignore                     # Excludes node_modules, __pycache__, and build artifacts
├── README.md                         # Architecture, run instructions, assumptions, and AI note
├── backend/
│   ├── pyproject.toml                # Pytest & Ruff linter configuration (line-length 110, py311)
│   ├── requirements.txt              # Pinned FastAPI, Pydantic v2, Pandas, NumPy, PyArrow, Pytest
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                   # FastAPI endpoints (/api/forecast, /api/accuracy, CSV exports)
│   │   ├── models.py                 # Strict Pydantic v2 request/response schemas & type hints
│   │   ├── cutoff_selector.py        # Core D-1 UK-time cutoff selector & post-cutoff exclusion guard
│   │   ├── metrics.py                # Error = forecast - actual, MAE, RMSE, Bias, guarded MAPE, P50/P90/P95
│   │   └── storage.py                # Local Parquet + SQLite cache manager & Elexon BMRS API client
│   ├── data/
│   │   ├── fuelhh_actuals.parquet    # Preloaded Jan 2026 FUELHH (fuelType=WIND) half-hourly actuals (1,488 rows)
│   │   ├── windfor_forecasts.parquet # Preloaded WINDFOR runs published 2025-12-15 to 2026-01-31 (23,098 rows)
│   │   └── bmrs_cache.sqlite         # Indexed SQLite cache containing fuelhh_actuals & windfor_forecasts
│   └── tests/
│       └── test_core.py              # Pytest / unittest suite for cutoff selection, MAPE guard & endpoints
└── frontend/
    ├── index.html                    # HTML entry point
    ├── package.json                  # React 18, TypeScript 5, Vite 5, Recharts, Lucide icons, Tailwind CSS
    ├── tsconfig.json                 # Strict TypeScript compiler configuration
    ├── vite.config.ts                # Vite dev server with /api proxy to FastAPI (:8000)
    └── src/
        ├── main.tsx                  # React DOM root mount
        ├── types.ts                  # TypeScript interfaces aligned with backend Pydantic models
        ├── preloadedData.ts          # Embedded Jan 2026 cache & deterministic client-side engine
        ├── api.ts                    # FastAPI REST client with offline preloaded fallback
        └── App.tsx                   # Forecast Desk, Accuracy & Risk Page, Cutoff Control, CSV Export
```

---

## How to Start the Application

### Option 1: Docker Compose (Recommended for Local Development)

Starts both the FastAPI backend (`http://localhost:8000`) and the React + Vite hot-reload development server (`http://localhost:5173`):

```bash
docker-compose up --build
```

- **Frontend UI:** `http://localhost:5173`
- **FastAPI Interactive Swagger Docs:** `http://localhost:8000/docs`
- **Health & Cache Status Check:** `http://localhost:8000/api/health`

### Option 2: Production Single-Container Multi-Stage Docker Build

Compiles the React + TypeScript frontend into static assets and serves both the SPA and `/api/*` endpoints from FastAPI on port `8000`:

```bash
docker build -t uk-wind-buying-portal .
docker run --rm -p 8000:8000 uk-wind-buying-portal
```

Then open `http://localhost:8000` in your browser.

### Option 3: Local Python + Node.js Execution (Without Docker)

**1. Run Backend & Automated Tests:**

```bash
pip install -r backend/requirements.txt
# Run unit and integration tests (compatible with both pytest and unittest)
PYTHONPATH=. pytest backend/tests -v
# Or using standard library unittest:
PYTHONPATH=. python3 -m unittest discover -s backend/tests -p "test_*.py" -v

# Start FastAPI server on port 8000
PYTHONPATH=. uvicorn backend.app.main:app --reload --port 8000
```

**2. Run Frontend Dev Server:**

```bash
cd frontend
npm install
npm run dev
```

---

## Core Domain Logic, Design Decisions & Assumptions

### 1. Strict Causal Decision-Cutoff Forecast Selection (`backend/app/cutoff_selector.py`)

- **Problem Context:** UK day-ahead power auctions (EPEX SPOT / Nord Pool N2EX) require utilities to finalize their bidding curves on the morning of `D-1` (typically around `09:00` UK local time ahead of auction gate closure). Evaluating wind forecast accuracy using intraday forecasts published on `D` or late on `D-1` introduces **look-ahead bias** and understates real procurement risk.
- **Selection Algorithm:**
  1. Given delivery day `D` (`YYYY-MM-DD` in January 2026) and configurable cutoff time `HH:MM` (default `09:00`), we construct a timezone-aware datetime on `D-1` in `ZoneInfo("Europe/London")` and convert it to UTC (`cutoff_utc`). In January, UK time is GMT (`UTC+0`), while using `ZoneInfo("Europe/London")` guarantees automatic BST (`UTC+1`) handling if extended to summer months.
  2. For each of the 48 half-hourly target `startTime` intervals on delivery day `D` (`00:00Z` to `23:30Z`), we filter `WINDFOR` records matching `startTime` to strictly require `publishTime <= cutoff_utc` and `publishTime <= startTime`.
  3. Any forecast with `publishTime > cutoff_utc` is **strictly excluded** and counted in `postCutoffExcluded` for audit transparency.
  4. Among eligible candidates, we select the record with the maximum `publishTime` and compute `horizonHours = (startTime - publishTime) / 3600`.
- **Early-January Coverage (`2025-12-15` Lookback):** Forecasts published from `2025-12-15T08:30:00Z` onwards are preloaded so that early-January delivery days (`2026-01-01`, `2026-01-02`) have complete multi-day lookback coverage even under early cutoff settings.

### 2. Error Definition & Guarded Accuracy Metrics (`backend/app/metrics.py`)

- **Sign Convention (`error = forecast − actual`):**
  - **Positive Error (`forecast > actual`):** Wind over-forecast. The utility expected more wind power than actually materialized, creating a **generation shortfall** that must be covered by purchasing additional thermal/balancing power.
  - **Negative Error (`forecast < actual`):** Wind under-forecast. Actual wind exceeded the decision-time forecast.
- **Metrics Computed:**
  - **MAE (Mean Absolute Error):** $\frac{1}{N}\sum |F_i - A_i|$ (MW) — average magnitude of half-hourly deviation.
  - **RMSE (Root Mean Squared Error):** $\sqrt{\frac{1}{N}\sum (F_i - A_i)^2}$ (MW) — penalizes large tail deviations during storm ramps.
  - **Bias (Mean Signed Error):** $\frac{1}{N}\sum (F_i - A_i)$ (MW) — measures systematic over- or under-prediction.
  - **Guarded MAPE (Mean Absolute Percentage Error):** Standard MAPE divides by $|A_i|$, which explodes or divides by zero during calm winter high-pressure periods ("Dunkelflaute") when wind generation approaches zero. Our implementation applies a configurable near-zero guard floor (`mape_guard_mw`, default `100.0 MW`), excluding near-zero intervals from unguarded division and reporting `mapeGuardedCount`.
  - **Tail Percentiles (`P50`, `P90`, `P95` of `|error|`):** Directly translates historical error distributions into physical reserve headroom: **"Forecast ± P90 MW covers 90% of half-hourly outcomes."**

### 3. January 2026 Quantitative Benchmark Summary

Across all **1,488 half-hourly settlement periods** in January 2026, varying the `D-1` decision cutoff demonstrates the operational value of later NGESO forecast runs:

| D-1 Decision Cutoff (UK) | Latest NGESO Run Used on D-1 | Lead Horizon Range | MAE (MW) | RMSE (MW) | Signed Bias (MW) | Guarded MAPE (%) | P50 \|Error\| (MW) | P90 \|Error\| (90% Coverage) | P95 \|Error\| (MW) |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **02:00 UK** | `D-2 23:30 UTC` | `24.5h – 48.0h` | 257.39 | 319.34 | +98.46 | 2.88% | 220.50 | **±517 MW** (516.6) | 611.55 |
| **06:00 UK** | `D-1 05:30 UTC` | `18.5h – 42.0h` | 242.09 | 297.96 | +83.55 | 2.77% | 210.50 | **±479 MW** (479.0) | 562.65 |
| **09:00 UK (Default)** | `D-1 08:30 UTC` | `15.5h – 39.0h` | **232.72** | **287.41** | **+28.15** | **2.58%** | **203.00** | **±465 MW** (465.3) | **556.00** |
| **11:00 UK (Auction)** | `D-1 10:30 UTC` | `13.5h – 37.0h` | 225.68 | 279.39 | +30.14 | 2.63% | 191.00 | **±464 MW** (464.3) | 546.30 |
| **13:00 UK** | `D-1 12:30 UTC` | `11.5h – 35.0h` | 212.95 | 259.65 | +41.52 | 2.33% | 187.00 | **±426 MW** (426.0) | 495.00 |
| **20:00 UK** | `D-1 19:30 UTC` | `4.5h – 28.0h` | 200.14 | 251.65 | +41.43 | 2.24% | 169.00 | **±410 MW** (409.6) | 492.00 |
