/**
 * /api/grade — Vercel serverless function (Node runtime).
 *
 * The API key lives ONLY here, in the server environment. The browser
 * posts {question, marks, answer} and gets back strict JSON:
 *   { score, verdict, feedback, modelAnswer }
 *
 * ENV (set in Vercel → Project Settings → Environment Variables,
 *      or in .env locally):
 *
 *   ANTHROPIC_API_KEY   (or GRADER_API_KEY)   — key for the gateway below
 *   ANTHROPIC_BASE_URL  (or GRADER_BASE_URL)  — e.g. https://agentrouter.org
 *   AI_MODEL            (or GRADER_MODEL)     — model id the gateway serves
 *   ALLOWED_MODELS                            — optional comma-separated allowlist
 *   AI_MAX_TOKENS / AI_TEMPERATURE / AI_TIMEOUT_SECONDS — optional
 *
 * A GET to this route returns a health summary (never the key) so the page
 * can show "Grader online / offline" without a round-trip to the model.
 */

'use strict';

/* .env files often contain shell-style refs like AI_MODEL=${MODEL_OPUS_5}.
   Vercel does NOT expand those, so we resolve them ourselves. */
function envVal(...names) {
  for (const n of names) {
    let v = process.env[n];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^['"]|['"]$/g, '');
    if (!v) continue;
    // resolve ${OTHER_VAR} up to a few levels deep
    for (let i = 0; i < 5 && /\$\{?\w+\}?/.test(v); i++) {
      v = v.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
        const r = process.env[a || b];
        return typeof r === 'string' ? r.trim().replace(/^['"]|['"]$/g, '') : '';
      }).trim();
    }
    if (v) return v;
  }
  return '';
}

function config() {
  const key = envVal('GRADER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY');
  let base = envVal('GRADER_BASE_URL', 'ANTHROPIC_BASE_URL') || 'https://agentrouter.org';
  base = base.replace(/\/+$/, '');
  const model = envVal('AI_MODEL', 'GRADER_MODEL');
  const allowed = envVal('ALLOWED_MODELS')
    .split(',').map(s => s.trim()).filter(Boolean);
  return {
    key,
    base,
    model,
    allowed,
    maxTokens: Math.max(256, Math.min(8192, parseInt(envVal('AI_MAX_TOKENS'), 10) || 1200)),
    temperature: (() => { const t = parseFloat(envVal('AI_TEMPERATURE')); return Number.isFinite(t) ? t : 0; })(),
    timeoutMs: (Math.max(10, Math.min(120, parseInt(envVal('AI_TIMEOUT_SECONDS'), 10) || 60))) * 1000,
  };
}

/* --- crude in-memory rate limit -------------------------------
   Serverless instances are short-lived, so this is a speed bump
   against a single tab hammering the route, not a hard quota. */
const HITS = new Map();
const RATE_MAX = 40;              // requests …
const RATE_WINDOW_MS = 60 * 1000; // … per minute per IP

function rateLimited(req) {
  const ip = String(
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown'
  );
  const now = Date.now();
  const rec = HITS.get(ip);
  if (!rec || now > rec.reset) {
    HITS.set(ip, { n: 1, reset: now + RATE_WINDOW_MS });
    if (HITS.size > 5000) HITS.clear();
    return false;
  }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

/* Some gateways (AgentRouter among them) reject requests that arrive with
   Node's default fetch User-Agent — you get 401 "unauthorized client
   detected" even though the key is perfectly valid. Sending a normal client
   UA is what makes the difference, so it is not optional here. */
const CLIENT_UA = envVal('GRADER_USER_AGENT') || 'claude-cli/1.0.0 (external, cli)';

/* Anthropic-native endpoints need /v1/messages; OpenAI-compatible
   gateways (AgentRouter, OpenRouter, LiteLLM, Groq…) need /v1/chat/completions. */
function isAnthropicNative(base) {
  return /(^|\/\/)([\w-]+\.)?anthropic\.com/i.test(base);
}
function chatUrl(base) {
  return /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
}
function messagesUrl(base) {
  return /\/v\d+$/.test(base) ? base + '/messages' : base + '/v1/messages';
}

const SYSTEM_PROMPT = [
  'You are an experienced lecturer marking PHY 210 (Basic Electronics) written answers',
  'at the Federal University of Technology, Akure.',
  '',
  'Mark the student answer against what a correct script would need for the marks available.',
  'Award partial credit generously for correct physics stated imprecisely, but do NOT award',
  'marks for content that is absent, wrong, or vague hand-waving. Numerical questions must',
  'reach the right result (allow small rounding differences) to earn full marks.',
  '',
  'Reply with ONLY a JSON object, no prose and no code fences:',
  '{',
  '  "score": <number, 0..MAX_MARKS, may use .5 steps>,',
  '  "verdict": "correct" | "partial" | "incorrect",',
  '  "feedback": "<2-4 sentences, second person, naming exactly what was missing or wrong>",',
  '  "modelAnswer": "<the concise answer that would earn full marks; include key formulae/steps>"',
  '}',
  'Use "correct" only at >=85% of the marks, "incorrect" only at 0.',
].join('\n');

function userPrompt(question, marks, answer) {
  const a = String(answer || '').trim();
  return [
    'QUESTION (' + marks + ' marks):',
    question,
    '',
    'STUDENT ANSWER:',
    a ? a : '(the student left this blank)',
    '',
    'MAX_MARKS = ' + marks + '. Return the JSON object now.',
  ].join('\n');
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function callModel(cfg, system, user) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);

  try {
    let url, headers, body;

    if (isAnthropicNative(cfg.base)) {
      url = messagesUrl(cfg.base);
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
        'User-Agent': CLIENT_UA,
      };
      body = {
        model: cfg.model || 'claude-sonnet-4-5',
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        system,
        messages: [{ role: 'user', content: user }],
      };
    } else {
      url = chatUrl(cfg.base);
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.key,
        'User-Agent': CLIENT_UA,
      };
      body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
    }

    let r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    // Some gateways choke on temperature/max_tokens combos — retry bare once.
    if (r.status === 400 || r.status === 422) {
      const bare = { ...body };
      delete bare.temperature;
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bare), signal: ctl.signal });
    }

    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (_) {}

    if (!r.ok) {
      const msg =
        (data && data.error && (data.error.message || data.error.type)) ||
        (data && data.message) ||
        raw.slice(0, 300) ||
        ('HTTP ' + r.status);
      const err = new Error('Grader upstream ' + r.status + ': ' + msg);
      err.status = 502;
      err.internal = true; // never surface upstream text to the browser
      throw err;
    }

    let text = '';
    if (data && Array.isArray(data.content)) {
      for (const b of data.content) if (b && b.type === 'text') text += b.text || '';
    } else if (data && data.choices && data.choices[0]) {
      const m = data.choices[0].message || {};
      text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (p && p.text) || '').join('')
          : '';
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const cfg = config();

  /* Health probe — booleans only. No key, no model id, no env hints:
     the page just needs to know whether marking is available. */
  if (req.method === 'GET') {
    const ready = Boolean(cfg.key && cfg.model) &&
      (!cfg.allowed.length || cfg.allowed.includes(cfg.model));
    if (!ready) {
      console.error('[grade] not configured:', {
        key: Boolean(cfg.key),
        model: cfg.model || null,
        allowedOk: !cfg.allowed.length || cfg.allowed.includes(cfg.model),
      });
    }
    res.status(200).end(JSON.stringify({ ok: ready }));
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }

  if (rateLimited(req)) {
    res.setHeader('Retry-After', '60');
    res.status(429).end(JSON.stringify({
      error: 'Too many requests in a row. Wait a minute, then try again.',
    }));
    return;
  }

  /* Misconfiguration is our problem, not the student's — log the
     specifics server-side and hand back one neutral sentence. */
  if (!cfg.key || !cfg.model || (cfg.allowed.length && !cfg.allowed.includes(cfg.model))) {
    console.error('[grade] refusing request — bad server config:', {
      hasKey: Boolean(cfg.key),
      model: cfg.model || null,
      allowed: cfg.allowed,
    });
    res.status(503).end(JSON.stringify({
      error: 'Marking is temporarily unavailable. Please try again shortly.',
    }));
    return;
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (_) {
    payload = null;
  }
  if (!payload) {
    res.status(400).end(JSON.stringify({ error: 'Body must be JSON.' }));
    return;
  }

  const question = String(payload.question || '').trim();
  const marks = Math.max(1, Math.min(100, Number(payload.marks) || 1));
  const answer = String(payload.answer || '');

  if (!question) {
    res.status(400).end(JSON.stringify({ error: '"question" is required.' }));
    return;
  }
  if (question.length + answer.length > 20000) {
    res.status(413).end(JSON.stringify({ error: 'Answer too long.' }));
    return;
  }

  // Short-circuit blank answers: no need to spend a model call.
  if (!answer.trim()) {
    res.status(200).end(JSON.stringify({
      score: 0,
      verdict: 'incorrect',
      feedback: 'You left this one blank, so there is nothing to award marks for. Read the model answer below, then try the question again in a fresh session.',
      modelAnswer: '',
    }));
    return;
  }

  try {
    const text = await callModel(cfg, SYSTEM_PROMPT, userPrompt(question, marks, answer));
    const parsed = extractJson(text);

    if (!parsed) {
      res.status(502).end(JSON.stringify({
        error: 'The grader replied in a format we could not read. Try again.',
      }));
      return;
    }

    let score = Number(parsed.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(marks, score));

    let verdict = String(parsed.verdict || '').toLowerCase();
    if (!['correct', 'partial', 'incorrect'].includes(verdict)) {
      verdict = score >= marks * 0.85 ? 'correct' : (score > 0 ? 'partial' : 'incorrect');
    }

    res.status(200).end(JSON.stringify({
      score,
      verdict,
      feedback: String(parsed.feedback || ''),
      modelAnswer: String(parsed.modelAnswer || parsed.model_answer || ''),
    }));
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    console.error('[grade] failed:', (e && e.message) || e);
    res.status(aborted ? 504 : (e.status || 502)).end(JSON.stringify({
      error: aborted
        ? 'The grader took too long to answer. Please try again.'
        : 'Marking failed just now. Please try again.',
    }));
  }
};
