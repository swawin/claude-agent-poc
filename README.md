# Minimal Claude Execution Tool Demo

A minimal full-stack demo app:
- **Frontend:** React + Vite (deployable to Vercel)
- **Backend:** Node.js + Express (deployable to Railway)
- **Feature:** Submit a task and optional CSV file; backend calls Claude to clean/transform data and return result + logs.

## Project structure

- `frontend/` React UI
- `backend/` Express API with `POST /execute`

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

Set `ANTHROPIC_API_KEY` in `backend/.env`.

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

Response:

```json
{
  "result": "...cleaned output...",
  "logs": ["step 1...", "step 2..."]
}
```

## Deploy

### Frontend to Vercel

- Root directory: `frontend`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_URL` set to Railway backend URL

### Backend to Railway

- Root directory: `backend`
- Start command: `npm start`
- Set environment variable: `ANTHROPIC_API_KEY`
- Optional: `CLAUDE_MODEL` (defaults to `claude-sonnet-4-5`)
