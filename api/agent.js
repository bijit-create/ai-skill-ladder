// AI Skill Ladder — live agent (Vercel serverless function)
// ---------------------------------------------------------------------------
// Holds the Anthropic API key (env var ANTHROPIC_API_KEY) and drives the
// adaptive MCQ assessment. The browser (index.html) calls this with:
//   { action: "next",  department, history }  -> one adaptive MCQ
//   { action: "score", department, history }  -> { score 1-10, level, dimensions[6], insight }
//
// Deploy: put the AI-Skill-Ladder-Web folder on Vercel (or GitHub -> Vercel),
// set the ANTHROPIC_API_KEY environment variable, and index.html will reach
// this at /api/agent automatically. Run locally with `vercel dev`.
//
// Model note: defaults to Claude Opus 4.8 for the best, most calibrated
// questions and scoring. To trade some quality for lower latency/cost, change
// MODEL to "claude-sonnet-4-6" or "claude-haiku-4-5".

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const MODEL = "claude-opus-4-8";
const TOTAL = 10;
const DIMS = ["Adoption", "Prompting", "Reusable skills", "Verification", "Automation", "Building"];

const NEXT_SCHEMA = {
  type: "object",
  properties: {
    area: { type: "string", description: "Which dimension this question probes (one of: " + DIMS.join(", ") + ")" },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } }
  },
  required: ["area", "question", "options"],
  additionalProperties: false
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    level: { type: "string" },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "integer" } },
        required: ["name", "value"],
        additionalProperties: false
      }
    },
    insight: { type: "string" }
  },
  required: ["score", "level", "dimensions", "insight"],
  additionalProperties: false
};

function nextSystem(department, n) {
  return `You are assessing how much a person's real work is powered by AI. They work in the ${department} team at ConveGenius, an Indian EdTech company that builds learning content, apps, and assessments and runs school and government education programmes.

You ask ONE multiple-choice question at a time and adapt to their previous answers. This is question ${n} of ${TOTAL}.

Write the question so that:
- It is grounded in a concrete, recurring ${department} task — not a generic "do you use AI" question.
- There are EXACTLY 4 options. Each option describes a real behaviour the person might actually do, in plain words.
- The 4 options are CLOSE and subtly different, so someone can't just spot and pick the "best" one. Do NOT write an obvious 1-2-3-4 ladder, and do NOT always put the most advanced option last — vary the order.
- Across the 10 questions you cover these six dimensions: ${DIMS.join(", ")}. Return the dimension you are probing in "area". Don't keep repeating a dimension already covered well unless you are deliberately probing deeper.
- Adapt to the history: if their answers show high maturity, ask harder questions that separate "builds a tool for myself" from "ships tools/agents other people depend on". If their answers show low maturity, calibrate between "doesn't really use AI" and "uses it for quick drafts".
- Use plain English. The audience includes non-native English speakers. Not childish, no jargon.

Return only the JSON object.`;
}

function scoreSystem(department) {
  return `You are scoring an AI-usage maturity self-check for a person in the ${department} team at an EdTech company.

Give an overall integer score from 1 to 10, anchored like this:
- 1 = does not use AI, or does not think they need to, or has only just started.
- 4 = uses AI for drafts and ideas, then assembles the rest by hand.
- 6 = hands whole tasks to AI with a clear brief and reusable setups, and reviews the output.
- 8 = has built a tool or automation that runs at scale, with checks on it.
- 10 = builds and ships tools or agents that other people rely on (inside or outside the company), has automated their own workflows, and has helped others build.

Score ONLY from the behaviours the person actually selected (in the transcript). Be calibrated and slightly strict — most real people land between 3 and 6. Don't inflate.

Also rate each of these six dimensions from 1 to 10, returning them with these EXACT names: ${DIMS.join(", ")}.

Write a 1-2 sentence "insight" for the team lead (the person being assessed will NOT see it): what they do well, and the single biggest opportunity to push their workflow further toward automation and building tools.

Give a short, friendly "level" label for the overall score (for example: "Just starting", "Hands-on user", "Delegator", "Builder", "Ships for others").

Return only the JSON object.`;
}

function firstJson(message) {
  const block = (message.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("no text block in model response");
  return JSON.parse(block.text);
}

async function nextQuestion(department, history) {
  const n = (history ? history.length : 0) + 1;
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: nextSystem(department, n),
    messages: [{ role: "user", content: JSON.stringify({ department, questionNumber: n, total: TOTAL, history: history || [] }) }],
    output_config: { format: { type: "json_schema", schema: NEXT_SCHEMA } }
  });
  const q = firstJson(message);
  if (!Array.isArray(q.options) || q.options.length !== 4) {
    // keep the contract the UI expects: exactly 4 options
    q.options = (q.options || []).slice(0, 4);
    while (q.options.length < 4) q.options.push("(no answer)");
  }
  return q;
}

async function score(department, history) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: scoreSystem(department),
    messages: [{ role: "user", content: JSON.stringify({ department, transcript: history || [] }) }],
    output_config: { format: { type: "json_schema", schema: SCORE_SCHEMA } }
  });
  const r = firstJson(message);
  r.score = Math.max(1, Math.min(10, Math.round(r.score)));
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

    if (action === "next") return res.status(200).json(await nextQuestion(department, history));
    if (action === "score") return res.status(200).json(await score(department, history));
    return res.status(400).json({ error: "unknown action: " + action });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
