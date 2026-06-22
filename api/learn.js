// AI Skill Ladder — the LEARNER (Vercel serverless function, run on a daily cron)
// ---------------------------------------------------------------------------
// Reads the accumulated responses, asks Claude to spot weak/non-discriminating
// question patterns and score clustering, and writes a BOUNDED, versioned
// "guidance" addendum back to the Sheet (Config tab). The agent (api/agent.js)
// reads that guidance and folds it into its question + scoring prompts — so the
// assessment sharpens itself over time, with no human gate (auto-apply).
//
// Bounded by design: it can only add { avoidPatterns, emphasize, calibrationHint }
// — it never rewrites the core rubric, so auto-apply stays safe and auditable
// (every version is logged in the Config tab).
//
// Trigger: Vercel Cron hits this daily (see vercel.json). You can also open the
// URL to run it manually. It no-ops until there are enough responses to learn from.
//
// Env: ANTHROPIC_API_KEY (required) · SHEET_API_URL (the /exec URL, required) ·
//      DASHBOARD_KEY (only if you set one) · CRON_SECRET (optional guard).

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";
const DIMS = ["Awareness", "Prompting", "Verification", "Reuse", "Automation", "Building"];
const MIN_ROWS = 10; // don't try to learn from too little data

const SHEET_API_URL = process.env.SHEET_API_URL || "";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const LEARN_SCHEMA = {
  type: "object",
  properties: {
    avoidPatterns: { type: "array", items: { type: "string" } },
    emphasize: { type: "array", items: { type: "string" } },
    calibrationHint: { type: "string" }
  },
  required: ["avoidPatterns", "emphasize", "calibrationHint"],
  additionalProperties: false
};

function firstJson(message) {
  const b = (message.content || []).find((x) => x.type === "text");
  if (!b) throw new Error("no text block in model response");
  return JSON.parse(b.text);
}

async function sheetGet(params) {
  const q = Object.assign({}, DASHBOARD_KEY ? { key: DASHBOARD_KEY } : {}, params || {});
  const url = SHEET_API_URL + (SHEET_API_URL.indexOf("?") >= 0 ? "&" : "?") + new URLSearchParams(q).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error("sheet read failed: " + r.status);
  return await r.json();
}

async function writeGuidance(guidance) {
  const r = await fetch(SHEET_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action: "guidance", guidance }, DASHBOARD_KEY ? { key: DASHBOARD_KEY } : {}))
  });
  return r.ok;
}

// Compact, model-friendly summary of the accumulated data.
function summarize(rows) {
  const byArea = {};        // area -> { choiceText -> count }
  const scoreCounts = {};   // score -> count
  const deptScores = {};    // dept -> [scores]
  rows.forEach((r) => {
    const s = Number(r.score) || 0;
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
    (deptScores[r.department] = deptScores[r.department] || []).push(s);
    (r.answers || []).forEach((a) => {
      const area = a.area || "?";
      byArea[area] = byArea[area] || {};
      const c = a.choice || "?";
      byArea[area][c] = (byArea[area][c] || 0) + 1;
    });
  });
  const deptSummary = {};
  Object.keys(deptScores).forEach((d) => {
    const arr = deptScores[d];
    deptSummary[d] = { n: arr.length, mean: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10, min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
  });
  return { responses: rows.length, parameters: DIMS, scoreCounts, byDepartment: deptSummary, chosenOptionsByArea: byArea };
}

function learnSystem() {
  return `You improve an adaptive AI-usage assessment by reviewing accumulated, anonymised response data.

The assessment scores six parameters (${DIMS.join(", ")}) and an overall 1-10. You are given, for each parameter, how often each answer option was chosen, plus the score distribution overall and per department.

Produce a SMALL, BOUNDED guidance addendum the question-writer and scorer will read:
- avoidPatterns: up to 5 short notes on weak/non-discriminating question patterns — e.g. an area where almost everyone picks the same option (so it doesn't separate people), or options that are too obviously ranked.
- emphasize: up to 5 short notes — under-probed parameters, or option styles that discriminate well and should be used more.
- calibrationHint: ONE short sentence about score spread — e.g. "Scores cluster at 6-7; push for more separation," naming a department if one stands out.

Rules: keep every item one short line; base everything ONLY on the data given; do NOT rewrite the scoring rubric or invent new parameters. Return only the JSON object.`;
}

export default async function handler(req, res) {
  if (CRON_SECRET) {
    const got = (req.query && req.query.secret) || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== CRON_SECRET) return res.status(401).json({ error: "unauthorized" });
  }
  if (!SHEET_API_URL) return res.status(400).json({ error: "SHEET_API_URL env var not set" });

  try {
    const data = await sheetGet({});
    const rows = (data && data.rows) || [];
    if (rows.length < MIN_ROWS) {
      return res.status(200).json({ ok: true, skipped: "need >= " + MIN_ROWS + " responses to learn (have " + rows.length + ")" });
    }

    const summary = summarize(rows);

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      system: learnSystem(),
      messages: [{ role: "user", content: JSON.stringify(summary) }],
      output_config: { format: { type: "json_schema", schema: LEARN_SCHEMA } }
    });
    const out = firstJson(message);

    // version = previous + 1 (numeric), else 1
    let prevVersion = 0;
    try { const g = await sheetGet({ guidance: "1" }); prevVersion = parseInt(g && g.guidance && g.guidance.version, 10) || 0; } catch (e) {}
    const guidance = {
      avoidPatterns: out.avoidPatterns || [],
      emphasize: out.emphasize || [],
      calibrationHint: out.calibrationHint || "",
      version: prevVersion + 1,
      basedOnResponses: rows.length
    };

    const wrote = await writeGuidance(guidance);
    return res.status(200).json({ ok: wrote, guidance });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
