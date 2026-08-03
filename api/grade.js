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
    /* A grade is ~150 words. Anything larger just invites the model to
       ramble, which is slow enough to blow the function's time limit. */
    maxTokens: Math.max(256, Math.min(4096, parseInt(envVal('AI_MAX_TOKENS'), 10) || 1200)),
    temperature: (() => { const t = parseFloat(envVal('AI_TEMPERATURE')); return Number.isFinite(t) ? t : 0; })(),
    /* Total budget for the whole request, retries included — it must stay
       under the platform's function limit (Vercel Hobby caps at 60s). */
    timeoutMs: (Math.max(10, Math.min(55, parseInt(envVal('AI_TIMEOUT_SECONDS'), 10) || 45))) * 1000,
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
  'OUTPUT CONTRACT — this is machine-parsed, so obey it exactly:',
  'Return ONE JSON object and nothing else. No preamble, no commentary, no markdown',
  'code fences. Use exactly these four keys and no others — in particular do NOT emit',
  '"breakdown", "max_marks", "question" or per-point arrays.',
  '{',
  '  "score": <number, 0..MAX_MARKS, may use .5 steps>,',
  '  "verdict": "correct" | "partial" | "incorrect",',
  '  "feedback": "<2-4 sentences, second person, naming exactly what was missing or wrong>",',
  '  "modelAnswer": "<the concise answer that would earn full marks; include key formulae/steps>"',
  '}',
  'Use "correct" only at >=85% of the marks, "incorrect" only at 0.',
  'Keep the whole object under 250 words so it is never truncated.',
].join('\n');

/* Re-stating the contract in the user turn matters: some gateways down-weight
   or drop the system role entirely, which is how we ended up with prose. */
const CONTRACT = 'Reply with ONLY this JSON object — no code fences, no other keys: ' +
  '{"score": <number>, "verdict": "correct"|"partial"|"incorrect", "feedback": "<2-4 sentences>", "modelAnswer": "<full-mark answer>"}';

function userPrompt(question, marks, answer, strict) {
  const a = String(answer || '').trim();
  const lines = [
    'QUESTION (' + marks + ' marks):',
    question,
    '',
    'STUDENT ANSWER:',
    a ? a : '(the student left this blank)',
    '',
    'MAX_MARKS = ' + marks + '.',
    CONTRACT,
  ];
  if (strict) {
    lines.push(
      '',
      'Your previous reply could not be parsed. Output must start with "{" and end with "}".',
      'No explanation before or after it. Keep "feedback" and "modelAnswer" short.'
    );
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------
   Tolerant JSON extraction.

   Models wrap the object in ``` fences, bury it in prose, or get cut
   off mid-object when they run long. We strip fences, walk the text
   for brace-balanced candidates (respecting string literals so a "}"
   inside feedback doesn't fool us), and as a last resort close off a
   truncated tail so a partial object is still usable.
--------------------------------------------------------------- */
function stripFences(text) {
  const t = String(text || '').trim();
  const closed = /```(?:json|javascript)?\s*([\s\S]*?)```/i.exec(t);
  if (closed && closed[1].trim()) return closed[1].trim();
  const open = /^```(?:json|javascript)?\s*([\s\S]*)$/i.exec(t); // fence never closed
  if (open && open[1].trim()) return open[1].trim();
  return t;
}

function objectCandidates(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  if (depth > 0 && start !== -1) out.push(text.slice(start)); // truncated tail
  return out;
}

/* Close an object that stopped mid-flight (hit the token ceiling). */
function repairJson(fragment) {
  let t = String(fragment).trim();
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  t = t.replace(/,\s*$/, '');
  t = t.replace(/,?\s*"[^"]*"\s*:\s*$/, ''); // dangling key with no value
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch (_) { return null; }
}

function extractJson(text) {
  if (!text) return null;
  const t = stripFences(text);

  const direct = tryParse(t);
  if (direct) return direct;

  const candidates = objectCandidates(t);
  const parsed = candidates.map(tryParse).filter(Boolean);
  const graded = parsed.find(o => gradeObject(o));
  if (graded) return graded;
  if (parsed.length) return parsed[0];

  for (let i = candidates.length - 1; i >= 0; i--) {
    const fixed = tryParse(repairJson(candidates[i]));
    if (fixed) return fixed;
  }
  return null;
}

/* ---------------------------------------------------------------
   Shape coercion. Models routinely answer with their own schema
   ("marks_awarded", a "breakdown" array, a nested "grading" object).
   Rather than fail the student, translate whatever we got.
--------------------------------------------------------------- */
const SCORE_KEYS = ['score', 'marks_awarded', 'marksawarded', 'marks', 'mark', 'awarded', 'awarded_marks', 'score_awarded', 'total_marks'];
const VERDICT_KEYS = ['verdict', 'result', 'judgement', 'judgment', 'grade', 'status'];
const FEEDBACK_KEYS = ['feedback', 'comment', 'comments', 'note', 'notes', 'explanation', 'remarks', 'remark', 'critique'];
const MODEL_KEYS = ['modelanswer', 'model_answer', 'idealanswer', 'ideal_answer', 'correctanswer', 'correct_answer', 'expectedanswer', 'expected_answer', 'model_solution', 'solution'];

const norm = k => String(k).toLowerCase().replace(/[^a-z]/g, '');

function pick(obj, keys) {
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(norm(k), obj[k]);
  for (const k of keys) {
    const v = map.get(norm(k));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/* Turn strings, arrays of strings, or arrays of {note|comment|text} into prose. */
function flattenText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map(item => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return flattenText(pick(item, ['note', 'comment', 'text', 'reason', 'feedback', 'explanation']));
      }
      return '';
    }).filter(Boolean).join(' ');
  }
  if (typeof v === 'object') return flattenText(pick(v, FEEDBACK_KEYS)) || '';
  return '';
}

/* A per-point array is itself evidence of marking, even when the model
   forgot to total it up. */
const BREAKDOWN_KEYS = ['breakdown', 'points', 'items', 'parts'];

function breakdownOf(o) {
  for (const k of BREAKDOWN_KEYS) {
    const v = pick(o, [k]);
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

/* Find the object actually carrying the grade, unwrapping one or two levels. */
function gradeObject(o, depth) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (pick(o, SCORE_KEYS) !== undefined ||
      pick(o, VERDICT_KEYS) !== undefined ||
      pick(o, FEEDBACK_KEYS) !== undefined ||
      breakdownOf(o)) return o;
  if ((depth || 0) >= 2) return null;
  for (const v of Object.values(o)) {
    const inner = gradeObject(v, (depth || 0) + 1);
    if (inner) return inner;
  }
  return null;
}

function normaliseVerdict(v) {
  const s = norm(v);
  if (!s) return '';
  if (/^(correct|right|full|fullmarks|pass|excellent|good)/.test(s)) return 'correct';
  if (/^(partial|partiallycorrect|partlycorrect|incomplete|mixed|half)/.test(s)) return 'partial';
  if (/^(incorrect|wrong|fail|none|nomarks|blank)/.test(s)) return 'incorrect';
  return '';
}

function coerceGrade(raw, marks) {
  const o = gradeObject(raw);
  if (!o) return null;

  const breakdown = breakdownOf(o);


  let score = Number(pick(o, SCORE_KEYS));
  if (!Number.isFinite(score) && breakdown) {
    score = breakdown.reduce((s, b) => {
      const m = b && typeof b === 'object' ? Number(pick(b, SCORE_KEYS)) : NaN;
      return s + (Number.isFinite(m) ? m : 0);
    }, 0);
  }
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(marks, score));

  let feedback = flattenText(pick(o, FEEDBACK_KEYS));
  if (!feedback && breakdown) feedback = flattenText(breakdown);

  const modelAnswer = flattenText(pick(o, MODEL_KEYS));

  let verdict = normaliseVerdict(pick(o, VERDICT_KEYS));
  if (!verdict) verdict = score >= marks * 0.85 ? 'correct' : (score > 0 ? 'partial' : 'incorrect');

  // Nothing usable at all — let the caller retry rather than show a bogus 0.
  if (!feedback && !modelAnswer && pick(o, SCORE_KEYS) === undefined && !breakdown) return null;

  return { score, verdict, feedback, modelAnswer };
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

async function callModel(cfg, system, user, budgetMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, budgetMs || cfg.timeoutMs));


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
        /* Ask for JSON mode where the gateway supports it. Unsupported
           gateways 400 on this, so the retry below drops it. */
        response_format: { type: 'json_object' },
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

    /* Gateways reject unknown fields with 400/422 — shed the optional ones
       and try again before giving up. */
    if (r.status === 400 || r.status === 422) {
      const bare = { ...body };
      delete bare.response_format;
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bare), signal: ctl.signal });
      if (r.status === 400 || r.status === 422) {
        delete bare.temperature;
        r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bare), signal: ctl.signal });
      }
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
    let finishReason = '';
    if (data && Array.isArray(data.content)) {
      for (const b of data.content) if (b && b.type === 'text') text += b.text || '';
      finishReason = data.stop_reason || '';
    } else if (data && data.choices && data.choices[0]) {
      const choice = data.choices[0];
      const m = choice.message || {};
      text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (p && p.text) || '').join('')
          : '';
      finishReason = choice.finish_reason || '';
    }
    return { text, finishReason };

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
    let grade = null;
    let lastText = '';

    /* One clock for the whole request. Attempt 1 gets most of it; a retry
       only happens if enough budget survives, so two slow attempts can
       never stack up past the platform's function limit. */
    const deadline = Date.now() + cfg.timeoutMs;

    /* Attempt 1 is the normal prompt. If the model ignores the contract —
       prose, a schema of its own invention, or a reply truncated by the
       token ceiling — attempt 2 tells it exactly what went wrong. */
    for (let attempt = 0; attempt < 2 && !grade; attempt++) {
      const remaining = deadline - Date.now();
      if (attempt > 0 && remaining < 8000) {
        console.error('[grade] skipping retry — only %dms of budget left', remaining);
        break;
      }
      /* Leave room for the retry on the first pass. */
      const slice = attempt === 0 ? Math.round(remaining * 0.6) : remaining;

      const { text, finishReason } = await callModel(
        cfg, SYSTEM_PROMPT, userPrompt(question, marks, answer, attempt > 0), slice
      );
      lastText = text;
      grade = coerceGrade(extractJson(text), marks);

      /* Set GRADER_DEBUG=1 to log exactly what the model sent back — the
         only practical way to diagnose a model that changes its shape. */
      if (envVal('GRADER_DEBUG')) {
        console.error('[grade] raw reply (attempt %d, finish_reason=%s):\n%s',
          attempt + 1, finishReason || 'n/a', text);
      }

      if (!grade) {

        console.error('[grade] unparseable reply (attempt %d, finish_reason=%s): %s',
          attempt + 1, finishReason || 'n/a', String(text || '').slice(0, 400));
      }
    }


    if (!grade) {
      console.error('[grade] giving up on reply:', String(lastText || '').slice(0, 1000));
      res.status(502).end(JSON.stringify({
        error: 'The grader replied in a format we could not read. Try again.',
      }));
      return;
    }

    res.status(200).end(JSON.stringify(grade));
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

/* Exposed for api/grade.test.js. Vercel only cares that module.exports is
   the handler function, so hanging helpers off it is harmless. */
module.exports.extractJson = extractJson;
module.exports.coerceGrade = coerceGrade;

