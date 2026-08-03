# PHY 210 :: Bench Test

A written-answer trainer for **PHY 210 (Basic Electronics)**, FUTA Dept. of Physics.
Students type answers exactly as they would on the script; an AI grader marks them
against what the question actually needs, awards partial credit, and shows a model answer.

> Not affiliated with the university. Question bank compiled from past questions
> and tests, sessions 2009/2010 – 2025/2026.

---

## What's in here

| Path             | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `index.html`     | The whole front end — question bank, practice/exam modes, review UI |
| `api/grade.js`   | Vercel serverless function that calls the model and returns marks    |
| `vercel.json`    | Security headers (CSP, frame options) + `no-store` on `/api/*`       |
| `.env.example`   | Names of the server-side environment variables (no real values)      |
| `.gitignore` / `.vercelignore` | Keep `.env` and keys out of git and out of deploys     |

**The API key never reaches the browser.** The page only ever posts to its own
`/api/grade` route; the key is read from the server environment inside the function.
Students never see, choose, or supply a model.

---

## Modes

- **Practice** — one question at a time, marked instantly, model answer revealed. No clock.
- **Timed Exam** — 25 minutes, 10 questions, free navigation, everything marked on submit.

Each session draws 10 random questions (crypto-seeded Fisher–Yates shuffle) from the bank.

---

## Deploy on Vercel

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project → Import** the repo. No build settings needed —
   it's a static `index.html` plus a Node function in `api/`.
3. **Project Settings → Environment Variables**, add (Production + Preview):

   | Name                 | Example                     | Required |
   | -------------------- | --------------------------- | -------- |
   | `ANTHROPIC_API_KEY`  | your gateway key            | yes      |
   | `ANTHROPIC_BASE_URL` | `https://agentrouter.org`   | yes      |
   | `AI_MODEL`           | model id the gateway serves | yes      |
   | `ALLOWED_MODELS`     | comma-separated allowlist   | no       |
   | `AI_MAX_TOKENS`      | `1200`                      | no       |
   | `AI_TEMPERATURE`     | `0`                         | no       |
   | `AI_TIMEOUT_SECONDS` | `60`                        | no       |

4. **Redeploy** after adding the variables — env changes don't apply to an existing build.

The header on the page shows **Grader ready** once `GET /api/grade` reports `{ok:true}`.
If it says *Grader unavailable*, the variables are missing, misspelled, or the deploy
predates them. Details are logged server-side only (Vercel → Deployment → Functions logs).

## Run locally

```bash
cp .env.example .env      # then fill in the real values
npx vercel dev            # serves index.html AND /api/grade
```

Opening `index.html` straight from disk (`file://`) will always show *Grader unavailable* —
there is no server behind `/api/grade` in that case.

---

## Editing the question bank

The bank is the `BANK` array near the top of the `<script>` block in `index.html`:

```js
{t:"Diodes", m:4, q:"Define a diode and explain its main function."},
```

`t` = topic (drives the topic pills and badges), `m` = marks available,
`q` = the question text. Add a row and it's live — topics and counters are derived automatically.

---

## Notes

- `/api/grade` rate-limits to 40 requests/minute per IP as a speed bump, not a quota.
- Blank answers are short-circuited server-side and score 0 without spending a model call.
- Upstream error text is never forwarded to the browser; students see one neutral sentence.
