// AI Skill Ladder — live agent (Vercel serverless function)
// ---------------------------------------------------------------------------
// An adaptive, observable, self-calibrating MCQ assessment. Holds the Anthropic
// API key (env ANTHROPIC_API_KEY). The browser (index.html) calls it with:
//   { action: "next",  department, history, guidance? } -> next MCQ OR { done:true }
//   { action: "score", department, history, guidance? } -> { score, level, dimensions[6], insight, reasoning }
// Every response also carries `_trace` { latencyMs, inTokens, outTokens, model }.
//
// THREE ROLES:
//   Orchestrator (next)  — picks the least-certain parameter to probe, or stops
//                          (adaptive 9-12 questions).
//   Scorer (score)       — 1-10 + 6 params, CALIBRATED against the department's
//                          distribution (peer-relative, with an absolute fallback
//                          when < 8 peers exist), plus a self-check.
//   Learner (api/learn)  — a separate cron function writes "guidance" that both
//                          steps read; see api/learn.js.
//
// Optional env for calibration + learned guidance (degrades gracefully if unset):
//   SHEET_API_URL  — the Apps Script /exec URL (so this function can read the Sheet)
//   DASHBOARD_KEY  — only if you set one in the Apps Script

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const MODEL = "claude-opus-4-8";
const MIN_Q = 9;   // always ask at least this many
const MAX_Q = 12;  // never ask more than this
const LEARNING_ON = true;
const DIMS = ["Awareness", "Prompting", "Verification", "Reuse", "Automation", "Building"];

const SHEET_API_URL = process.env.SHEET_API_URL || "";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";

const NEXT_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean", description: "true only when at least " + MIN_Q + " questions answered AND another question wouldn't change the assessment" },
    area: { type: "string", description: "Which parameter this question probes (one of: " + DIMS.join(", ") + ")" },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } }
  },
  required: ["done"],
  additionalProperties: false
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    level: { type: "string" },
    dimensions: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, value: { type: "integer" } }, required: ["name", "value"], additionalProperties: false }
    },
    insight: { type: "string" },
    reasoning: { type: "string" }
  },
  required: ["score", "level", "dimensions", "insight", "reasoning"],
  additionalProperties: false
};

function firstJson(message) {
  const b = (message.content || []).find((x) => x.type === "text");
  if (!b) throw new Error("no text block in model response");
  return JSON.parse(b.text);
}

// One model call, timed, with token usage captured for observability.
async function callModel(opts) {
  const t0 = Date.now();
  const message = await client.messages.create(opts);
  const u = message.usage || {};
  return {
    data: firstJson(message),
    trace: { latencyMs: Date.now() - t0, inTokens: u.input_tokens || 0, outTokens: u.output_tokens || 0, model: opts.model }
  };
}

// --- Sheet reads (all graceful: return null on any problem) ---
async function sheetGet(params) {
  if (!SHEET_API_URL) return null;
  try {
    const q = Object.assign({}, DASHBOARD_KEY ? { key: DASHBOARD_KEY } : {}, params || {});
    const url = SHEET_API_URL + (SHEET_API_URL.indexOf("?") >= 0 ? "&" : "?") + new URLSearchParams(q).toString();
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function getGuidance() {
  if (!LEARNING_ON) return null;
  const j = await sheetGet({ guidance: "1" });
  return j && j.guidance ? j.guidance : null;
}

async function getDeptDistribution(department) {
  const j = await sheetGet({ dept: department });
  if (!j || !Array.isArray(j.rows)) return null;
  const scores = j.rows
    .filter((r) => String(r.department) === String(department))
    .map((r) => Number(r.score))
    .filter((n) => n >= 1 && n <= 10);
  if (!scores.length) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { n: scores.length, mean: Math.round(mean * 10) / 10, min: Math.min.apply(null, scores), max: Math.max.apply(null, scores) };
}

function guidanceText(g) {
  if (!g) return "";
  const parts = [];
  if (g.avoidPatterns && g.avoidPatterns.length) parts.push("Avoid these weak question patterns seen in past sessions:\n- " + g.avoidPatterns.join("\n- "));
  if (g.emphasize && g.emphasize.length) parts.push("Emphasise:\n- " + g.emphasize.join("\n- "));
  if (g.calibrationHint) parts.push("Calibration note: " + g.calibrationHint);
  if (!parts.length) return "";
  return "\n\nLEARNED GUIDANCE (from past sessions, v" + (g.version || "?") + "):\n" + parts.join("\n");
}

function nextSystem(department, answered, guidance) {
  return `You are the ORCHESTRATOR of an adaptive AI-usage assessment for a person in the ${department} team at ConveGenius, an Indian EdTech company (learning content, apps, assessments, and school & government education programmes).

Your job each turn: decide the single best next multiple-choice question to learn the most about where this person sits — OR decide you have enough to score them confidently.

You measure SIX parameters in three layers (put the one you're probing in "area"):
- Awareness — reaches for AI by default, knows what it can do.
- Prompting, Verification — can they get good, trustworthy results?
- Reuse, Automation, Building — do they scale and create?

This person has answered ${answered} question(s). Ask at least ${MIN_Q} and at most ${MAX_Q}.
- If answered < ${MIN_Q}: you MUST return done:false with a question. Prioritise parameters not yet probed.
- If answered >= ${MIN_Q}: return done:true ONLY if all six parameters are covered AND one more question would not change the assessment. Otherwise return done:false and probe the parameter you are LEAST certain about.

When returning a question (done:false):
- Ground it in a concrete, recurring ${department} task — never a generic "do you use AI".
- EXACTLY 4 options, each a real behaviour in plain words, CLOSE and subtly different (no obvious 1-2-3-4 ladder; vary the order). For an Awareness question, probe mindset/instinct, not just frequency.
- Don't repeat a parameter already probed well unless deliberately going deeper on an uncertain one.
- Plain English; audience includes non-native speakers; not childish, no jargon.${guidanceText(guidance)}

Return only the JSON object.`;
}

function scoreSystem(department, dist, guidance) {
  let calib;
  if (dist && dist.n >= 8) {
    calib = `CALIBRATE AGAINST PEERS: the ${department} team has ${dist.n} prior responses, scores ${dist.min}-${dist.max} (avg ${dist.mean}). Anchor on the absolute rubric, then place this person RELATIVE to that spread so results discriminate — do not pile everyone at 6-7. If they are clearly stronger or weaker than the typical ${department} respondent, let the score reflect it.`;
  } else {
    calib = `Use the absolute rubric below — the ${department} team has too few prior responses to calibrate against, so do not curve.`;
  }
  return `You are the SCORER for an AI-usage maturity assessment for a person in the ${department} team at an EdTech company.

Overall integer score 1-10, anchored:
- 1 = doesn't use AI / doesn't think they need to / only just started.
- 4 = uses AI for drafts and ideas, assembles the rest by hand.
- 6 = hands whole tasks to AI with a clear brief and reusable setups, reviews output.
- 8 = built a tool/automation that runs at scale, with checks.
- 10 = builds & ships tools/agents others rely on, automated their workflows, helps others build.

Score ONLY from the behaviours selected in the transcript. Be calibrated and slightly strict.

${calib}

Then SELF-CHECK: would a stricter reviewer agree this exact score is earned by these specific behaviours? Adjust before returning if not. Put a 1-2 sentence justification (citing the behaviours that set the score) in "reasoning".

Rate each of the six parameters 1-10 with these EXACT names: ${DIMS.join(", ")}.
- Awareness: reaches for AI by default. Prompting: briefs AI well. Verification: checks output before trusting. Reuse: reusable skills/templates. Automation: runs AI at volume/on a schedule. Building: builds tools/agents others use.

"insight": 1-2 sentences for the team lead (the person will NOT see it) — strength + biggest opportunity.
"level": short friendly label (e.g. "Just starting", "Hands-on user", "Builder", "Ships for others").${guidanceText(guidance)}

Return only the JSON object.`;
}

async function nextQuestion(department, history, guidance) {
  const answered = (history || []).length;
  if (answered >= MAX_Q) return { done: true, _trace: null };

  const { data, trace } = await callModel({
    model: MODEL,
    max_tokens: 1024,
    system: nextSystem(department, answered, guidance),
    messages: [{ role: "user", content: JSON.stringify({ department, answered, min: MIN_Q, max: MAX_Q, history: history || [] }) }],
    output_config: { format: { type: "json_schema", schema: NEXT_SCHEMA } }
  });

  const q = data;
  if (answered < MIN_Q) q.done = false; // cannot stop before the minimum
  if (!q.done) {
    if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) {
      if (answered >= MIN_Q) { return { done: true, _trace: trace }; } // model gave nothing usable but we have enough — score
      q.options = (q.options || []).slice(0, 4);
      while (q.options.length < 4) q.options.push("(no answer)");
      if (!q.question) q.question = "In your day-to-day work, how does AI usually show up?";
      if (!q.area) q.area = "Awareness";
    }
  }
  q._trace = trace;
  return q;
}

async function score(department, history, guidance) {
  const dist = await getDeptDistribution(department);
  const { data, trace } = await callModel({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: scoreSystem(department, dist, guidance),
    messages: [{ role: "user", content: JSON.stringify({ department, transcript: history || [] }) }],
    output_config: { format: { type: "json_schema", schema: SCORE_SCHEMA } }
  });
  const r = data;
  r.score = Math.max(1, Math.min(10, Math.round(r.score)));
  r._trace = trace;
  r._calibratedAgainstPeers = !!(dist && dist.n >= 8);
  return r;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { action, department, history } = body;
    if (!department) return res.status(400).json({ error: "department is required" });

    if (action === "next") {
      // Fetch learned guidance once per session (first question), then the client carries it.
      let guidance = body.guidance;
      let fetched = false;
      if (guidance === undefined && (!history || history.length === 0)) { guidance = await getGuidance(); fetched = true; }
      const q = await nextQuestion(department, history, guidance || null);
      if (fetched) q.guidance = guidance || null; // hand it to the client to carry on later calls
      return res.status(200).json(q);
    }
    if (action === "score") {
      return res.status(200).json(await score(department, history, body.guidance || null));
    }
    return res.status(400).json({ error: "unknown action: " + action });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
