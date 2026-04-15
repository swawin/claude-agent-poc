# Claude Agent CSV Execution Demo

A lightweight full-stack demo app for comparing two execution strategies side-by-side for CSV cleaning:
- **Frontend:** React + Vite (deployable to Vercel)
- **Backend:** Node.js + Express (deployable to Railway)
- **CSV use case:** Upload CSV + describe a task, then run either deterministic backend logic or dynamic Claude-driven execution.

## Execution modes

### 1) Deterministic execution (`POST /execute`)
The existing production-like path. Backend code performs the transformations directly:
- Parse CSV headers + rows
- Trim whitespace in headers/values
- Normalize headers (`lowercase_with_underscores`)
- Remove exact duplicate rows
- Normalize supported date formats to `YYYY-MM-DD`
- Handle missing/null-like values
- Return cleaned CSV + logs + metadata

Claude is only used to interpret intent and generate a short summary (with fallback logic if API key is absent).

### 2) Dynamic Claude execution (`POST /execute-dynamic`) **(experimental)**
An agent-style path where Claude is prompted to:
1. inspect the uploaded CSV
2. produce a concise plan
3. generate transformation code dynamically
4. run that code via Anthropic's **code execution tool**
5. inspect candidate output
6. retry/revise within a bounded loop (max 3 iterations) when backend validation fails
7. return final cleaned CSV + summary + metadata + optional artifacts

> This mode is intentionally bounded and experimental. It is not a fully general autonomous agent.

## Tradeoffs: deterministic vs dynamic

- **Deterministic mode**
  - Faster and cheaper
  - More predictable behavior
  - Best for repeatable known transformations

- **Dynamic mode**
  - More flexible for varied tasks
  - Slower and potentially higher cost (tool calls + retries)
  - Better for experimentation and agentic workflows

## Project structure

- `frontend/` React UI
- `backend/` Express API
  - `POST /execute` (deterministic)
  - `POST /execute-dynamic` (dynamic)
  - `backend/lib/csvProcessor.js`: deterministic real CSV pipeline
  - `backend/lib/taskPlanner.js`: deterministic intent + summary helpers
  - `backend/lib/dynamicExecutionService.js`: dynamic tool-use loop
  - `backend/lib/dynamicValidation.js`: backend validation for dynamic output

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
- `ANTHROPIC_API_KEY` (required for dynamic mode; optional for deterministic fallback behavior)
- `CLAUDE_MODEL` (optional, defaults to `claude-sonnet-4-5`)

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

Optional:
- `VITE_API_URL` (defaults to `http://localhost:4000`)

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
`multipart/form-data`:
- `task` (string)
- `file` (optional CSV)

No file:
- advisory response (`metadata.execution_mode = "advisory"`)

With file:
- deterministic cleaning (`metadata.execution_mode = "real_csv_processing"`)

### `POST /execute-dynamic`
`multipart/form-data`:
- `task` (string)
- `file` (optional CSV, but required for dynamic demo execution)

No file:
- structured advisory response (no server crash)

With file:
- dynamic agent execution (`metadata.execution_mode = "dynamic_agent_execution"`)
- bounded retries (`iterations_used <= 3`)
- backend validation checks after each candidate output

Example dynamic response shape:

```json
{
  "result": "<cleaned csv text>\n\nSummary:\n<concise summary>",
  "logs": [
    "Uploading CSV into dynamic execution context...",
    "Analyzing uploaded CSV and task requirements...",
    "Preparing dynamic execution plan...",
    "Generating transformation code (iteration 1/3)...",
    "Executing code in Anthropic sandbox...",
    "Inspecting generated output...",
    "Validation passed. Preparing final response..."
  ],
  "metadata": {
    "execution_mode": "dynamic_agent_execution",
    "rows_input": 10,
    "rows_output": 8,
    "duplicates_removed": 2,
    "dates_normalized": 4,
    "validation_passed": true,
    "iterations_used": 1,
    "warnings": [],
    "dynamic_code_used": true
  },
  "artifacts": {
    "plan": "Inspect schema -> clean -> validate",
    "generated_code": "<optional excerpt>"
  }
}
```

## Dynamic mode validation checks

After Claude returns candidate CSV, backend performs lightweight validation:
- Parse candidate CSV
- Ensure non-empty output
- Count rows
- Heuristically verify duplicate removal when requested
- Heuristically verify date normalization when requested
- Return warnings/failures; feed failures into the next iteration

## Error handling

The app returns user-friendly errors for:
- missing `ANTHROPIC_API_KEY` in dynamic mode
- code execution/tool-use failures
- malformed CSV
- empty file
- unusable Claude output
- validation failures after max iterations

## Frontend UX

UI includes a mode selector:
- **Deterministic Execution** → calls `/execute`
- **Dynamic Claude Execution** → calls `/execute-dynamic`

The frontend displays execution mode, iterations used, validation status, logs, metadata, and optional dynamic artifacts (plan/code excerpt).

## Supported date formats (deterministic mode)

Input formats normalized when valid:
- `YYYY/MM/DD`
- `YYYY-MM-DD`
- `MM/DD/YYYY`
- `DD-MM-YYYY`

Ambiguous or invalid date-like values are left unchanged and added as warnings.

## Deploy

### Frontend to Vercel

- Root directory: `frontend`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_URL` set to Railway backend URL

### Backend to Railway

- Root directory: `backend`
- Start command: `npm start`
- Environment variables:
  - `ANTHROPIC_API_KEY`
  - `CLAUDE_MODEL` (optional)
