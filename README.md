# AI Skill Ladder — live adaptive agent

A 2-minute adaptive MCQ assessment of AI-usage maturity, powered by the Claude API.

- `index.html` — what people take; shows a 1–10 score (name + team + Delhi-NCR question).
- `api/agent.js` — Vercel serverless function: generates each adaptive question and scores 1–10. **Holds the API key.**
- `dashboard.html` — backend view: spider charts per department and per person.
- `package.json` — declares `@anthropic-ai/sdk`.

## Deploy (GitHub + Vercel)
1. Push this folder to a GitHub repo.
2. In Vercel: **New Project → import the repo → Deploy** (no build settings needed — it's static files + one function).
3. **Settings → Environment Variables → add `ANTHROPIC_API_KEY`** (from console.anthropic.com) → **Redeploy**.
4. Live: `https://<project>.vercel.app/` · dashboard: `https://<project>.vercel.app/dashboard.html`

## Local dev
`npm i -g vercel`, then `vercel dev` (with `ANTHROPIC_API_KEY` set in your shell).

## Wiring
- Recording results + the dashboard's data come from a Google Apps Script web app — see `../AI-Skill-Ladder-Apps-Script.gs`. Put that `/exec` URL into `RECORDER_URL` in `index.html`.
- Model is `claude-opus-4-8`; change `MODEL` in `api/agent.js` for lower latency/cost.
- **Never commit the API key** — it lives only in Vercel's environment variables.
