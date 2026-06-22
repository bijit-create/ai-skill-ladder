# AI Skill Ladder — live, observable, self-improving agent

A 2-minute adaptive MCQ assessment of AI-usage maturity, powered by the Claude API.
An orchestrator decides how many questions to ask (**9–12**, stopping when it has a
clear read), scores 1–10 **calibrated against the department's spread**, logs full
**traces**, and a daily **learner** sharpens the questions from accumulated data.

- `index.html` — what people take; shows a 1–10 score + "where you are" + next steps.
- `api/agent.js` — Vercel function: orchestrator (`next`, adaptive 9–12) + scorer (`score`, peer-calibrated + self-check). Returns `_trace` (latency/tokens/model). **Holds the API key.**
- `api/learn.js` — daily cron: reads accumulated responses, writes a bounded, versioned "guidance" addendum back to the Sheet that the agent reads. Auto-applied.
- `dashboard.html` — backend view: spider charts per department and per person.
- `vercel.json` — schedules `/api/learn` daily.
- `package.json` — declares `@anthropic-ai/sdk`.

## Deploy (GitHub + Vercel)
1. Push this folder to a GitHub repo.
2. In Vercel: **New Project → import the repo → Deploy** (no build settings needed — it's static files + one function).
3. **Settings → Environment Variables** → add:
   - `ANTHROPIC_API_KEY` (required, from console.anthropic.com)
   - `SHEET_API_URL` (the Apps Script `/exec` URL) — enables peer calibration + the learner
   - `DASHBOARD_KEY` (only if you set one in the Apps Script)
   - `CRON_SECRET` (optional) — if set, `/api/learn` requires `?secret=…`
   Then **Redeploy**.
4. Live: `https://<project>.vercel.app/` · dashboard: `https://<project>.vercel.app/dashboard.html`

### What degrades gracefully
Without `SHEET_API_URL`, the agent still runs (adaptive questions + traces + self-check
scoring); it just falls back to the absolute rubric (no peer calibration) and uses no
learned guidance. Calibration needs ≥ 8 prior responses in a department before it curves.

### The learner
`/api/learn` runs daily (Vercel Cron, see `vercel.json`); it no-ops until there are ≥ 10
responses. It writes a bounded `{avoidPatterns, emphasize, calibrationHint}` guidance row
to the Sheet's **Config** tab (versioned, auditable, revertible). Run it manually any time
by opening `https://<project>.vercel.app/api/learn`. To pause learning, set
`LEARNING_ON = false` in `api/agent.js`.

## Local dev
`npm i -g vercel`, then `vercel dev` (with `ANTHROPIC_API_KEY` set in your shell).

## Wiring
- Recording results + the dashboard's data come from a Google Apps Script web app — see `../AI-Skill-Ladder-Apps-Script.gs`. Put that `/exec` URL into `RECORDER_URL` in `index.html`.
- Model is `claude-opus-4-8`; change `MODEL` in `api/agent.js` for lower latency/cost.
- **Never commit the API key** — it lives only in Vercel's environment variables.
