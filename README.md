# Claude Agent CSV Execution Demo (Real Processing)

A lightweight full-stack demo app:
- **Frontend:** React + Vite (deployable to Vercel)
- **Backend:** Node.js + Express (deployable to Railway)
- **Feature:** Submit a task and optional CSV file; backend now executes **real CSV parsing + cleaning** and returns output, logs, and metadata.

## What is real vs simulated

### Real backend execution (when a CSV is uploaded)
The backend now performs real processing in code:
- Parses CSV headers + rows.
- Trims whitespace in headers/values.
- Normalizes header names (lowercase + spaces to underscores).
- Removes exact duplicate rows.
- Normalizes supported date formats to `YYYY-MM-DD`.
- Handles missing/null-like values.
- Validates row counts and processing totals.
- Rebuilds cleaned CSV text programmatically.

### Claude's role now
Claude is used as a planner/interpreter/narrator (not the executor):
- Interprets task intent into a lightweight plan (booleans).
- Optionally writes a concise summary sentence.
- Provides advisory-only strategy when no CSV is uploaded.

If Claude is unavailable (or API key is missing), backend falls back to a default plan and still executes CSV transformations.

## Project structure

- `frontend/` React UI
- `backend/` Express API with `POST /execute`
  - `backend/lib/csvProcessor.js`: real CSV execution pipeline
  - `backend/lib/taskPlanner.js`: Claude intent + fallback plan logic

## Local setup

### 1) Install dependencies

From repo root:

```bash
npm install
npm --prefix backend install
npm --prefix frontend install
```

### 2) Configure env vars

Backend:

```bash
cp backend/.env.example backend/.env
```

Set:
- `ANTHROPIC_API_KEY` (optional but recommended)
- `CLAUDE_MODEL` (optional, defaults to `claude-sonnet-4-5`)

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

### 3) Run locally

In two terminals:

```bash
npm --prefix backend run dev
npm --prefix frontend run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## API

### `POST /execute`

`multipart/form-data` fields:
- `task` (string)
- `file` (optional CSV)

If no file is provided:
- `metadata.execution_mode = "advisory"`
- response contains a strategy/plan only

If file is provided:
- `metadata.execution_mode = "real_csv_processing"`
- response contains cleaned CSV + summary

Example response shape:

```json
{
  "result": "<cleaned csv>\n\nSummary:\n<short summary>",
  "logs": [
    "Analyzing uploaded CSV structure...",
    "Interpreting task intent...",
    "Normalizing headers and values...",
    "Scanning rows for duplicates and date values...",
    "Validating cleaned output...",
    "Generating summary...",
    "Finalizing result..."
  ],
  "metadata": {
    "execution_mode": "real_csv_processing",
    "rows_input": 4,
    "rows_output": 3,
    "columns_detected": ["name", "date", "amount"],
    "duplicates_removed": 1,
    "date_columns_detected": ["date"],
    "dates_normalized": 2,
    "missing_values_detected": 1,
    "warnings": [],
    "transformations_applied": ["..."],
    "validation_passed": true,
    "fallback_plan_used": false
  }
}
```

## Supported date formats

Input formats normalized when valid:
- `YYYY/MM/DD`
- `YYYY-MM-DD`
- `MM/DD/YYYY`
- `DD-MM-YYYY`

Ambiguous or invalid date-like values are left unchanged and added to metadata warnings.

## Example test CSV

```csv
 Name , Date , Amount
Alice,2024/01/02,100
Bob,01/03/2024,200
Bob,01/03/2024,200
Charlie,N/A,300
```

Expected effects:
- Headers become `name,date,amount`
- Duplicate Bob row removed
- Two date values normalized to `YYYY-MM-DD`
- Missing date remains blank unless task explicitly asks to flag missing dates

## Error handling

Backend returns meaningful errors for:
- invalid CSV format
- empty file
- inconsistent row shape
- malformed/ambiguous date values (warning, not fatal)
- Claude unavailable (fallback plan + warning)
- missing Anthropic API key (fallback plan + warning)

## Limitations of this demo

- Date detection is pattern-based and intentionally conservative.
- Missing-value handling focuses on common null-like tokens (`null`, `NULL`, `N/A`, `na`, empty string).
- No advanced schema inference, type casting, or multi-file workflows.
- Advisory mode does not execute transformations.

## Deploy

### Frontend to Vercel

- Root directory: `frontend`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_URL` set to Railway backend URL

### Backend to Railway

- Root directory: `backend`
- Start command: `npm start`
- Optional env var: `ANTHROPIC_API_KEY`
- Optional env var: `CLAUDE_MODEL`
