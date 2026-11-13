<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="ApplyFlow icon">
</p>

<h1 align="center">ApplyFlow</h1>

<p align="center">
  <b>From a LinkedIn hiring post to a sent, personalised application in three clicks.</b><br>
  Chrome extension · Node.js on Vercel · Supabase · Groq + Google Gemini · Gmail API
</p>

<p align="center">
  🌐 <b><a href="https://applyflow-ai-murex.vercel.app">applyflow-ai-murex.vercel.app</a></b>: product page, download and setup guide
</p>

<p align="center">
  <img src="docs/screenshots/02-window-light.png" width="860" alt="ApplyFlow window on a LinkedIn-style feed: job details, resume match and drafted email">
</p>

---

Many good jobs on LinkedIn are posted as ordinary feed posts: *"We're hiring, send your resume to …"*.
Applying to each one means screenshotting the post, asking ChatGPT for an email, fixing it, copying it into
Gmail, finding the right resume and attaching it: about ten minutes, every time.

**ApplyFlow does it in seconds, and you stay in control.**

- 🔍 **Detects hiring posts** while you scroll your feed, newest first
- 🧠 **Reads the job**: role, company, fresher/experienced, skills, requirements
- 📄 **Picks your best resume** from your library, with a match score
- ✍️ **Writes like you**, using an "About me" profile from your own AI assistant and your email skeleton
- 📤 **Sends from your Gmail** with the PDF attached, only after **Send → Confirm**
- 🕒 **Send later**: pick a time; the server sends it even if your laptop is off
- 📊 **Tracks every application** and warns before you apply to the same opening twice

**Free for testers:** the extension, the hosting, the Groq AI key and Gmail all cost nothing.

> 🧪 **Want to try it?** Open the **[website](https://applyflow-ai-murex.vercel.app)**, or follow **[TESTING.md](TESTING.md)**.
> No Node.js, no setup scripts: download the extension and load it in Chrome.
>
> 📘 [PRD.md](PRD.md): the product story and decisions · 🎨 [SHOWCASE.md](SHOWCASE.md): every screen

## How it works

```
LinkedIn feed ─▶ content.js spots a hiring post → "Hiring post detected"           (instant, no AI)
Open it       ─▶ POST /api/analyze-job   → AI job summary                           (~1 s)
Generate      ─▶ POST /api/applications/:id/prepare → resume match + email in 1 call (~1–3 s)
Send          ─▶ POST /api/applications/:id/send     → Gmail API, PDF attached
Send later    ─▶ POST /api/applications/:id/schedule → Supabase pg_cron → /internal/send-due
```

One backend on Vercel serves every tester. Each copy of the extension creates a random **tester ID**
on install and sends it with every request (`X-ApplyFlow-User`); the backend keeps each tester's data
separate by that ID. There are no accounts and no passwords.

| Layer | Tech |
|---|---|
| Browser | Chrome extension, Manifest V3 (vanilla JS/CSS, Inter font) |
| Backend | Node.js + Express 5 on **Vercel** (Mumbai, `bom1`), also runs locally |
| Storage | **Supabase** (Mumbai): `applyflow_kv` (per-tester JSON documents), private `resumes` bucket, `applyflow_schedule` queue |
| AI | Each tester's own **Groq** key (`gpt-oss-120b` / `gpt-oss-20b`), optional **Gemini** backup: fallback, racing, retries |
| Email | Gmail API, OAuth 2.0 web client + PKCE, `gmail.send` scope only |
| Jobs | Supabase **pg_cron**: due scheduled emails every minute, keep-warm ping every 3 minutes |
| Website | `backend/public/`: product page, setup guide and the extension zip |

---

## 1. Repository layout

```
extension/            Chrome extension (what testers load)
  config.js           backend address + tester ID
  content.js          LinkedIn: detection, notification + floating window
  background.js       service worker: talks to the backend
  dashboard.*         Applications · Resumes · Settings
  review.*            full-page application view
  schedule-time.js    "Send later" time helpers
backend/
  server.js           routes (API, Gmail OAuth, cron endpoints, website)
  lib/context.js      which tester is this request for
  lib/store.js        per-tester storage: Supabase, or files on your PC
  lib/ai-router.js    AI providers, racing, fallbacks, per-tester keys
  lib/ai.js           prompts + validation (job, resume, match, email)
  lib/about-me.js     "About me" condensing (resumable, rate-limit aware)
  lib/scheduler.js    Send later: queue, claim, run
  lib/sender.js       the one place that sends an application
  lib/gmail.js        OAuth + MIME email with attachment
  public/             website + ApplyFlow-extension.zip (built)
  scripts/build-extension-zip.mjs
  supabase/migrations SQL for tables, claim function, cron jobs
  tests/              node --test (74 tests)
```

## 2. Making changes

```powershell
cd backend
npm.cmd install
npm.cmd test                 # 74 tests, uses a temporary folder (never real data)
npm.cmd run build:zip        # after ANY change in /extension: rebuilds public/ApplyFlow-extension.zip
```

A test fails if the extension changed but the zip wasn't rebuilt, so testers never download an old version.

**Deploy:** pushing to `main` deploys to Vercel automatically (project root directory: `backend`).
Database changes go in `backend/supabase/migrations/` and are applied with
`npx supabase db push --remote` (from `backend`).

### Run the backend on your own PC (optional, for development)
1. `backend/.env` from `.env.example`: `GROQ_API_KEY`, Google **Desktop app** OAuth client.
   Leave `SUPABASE_*` empty to store data in `backend/data/users/<tester>/`.
2. `npm.cmd start` → http://127.0.0.1:3000 (also serves the website).
3. In `extension/config.js`, set `APPLYFLOW_API = "http://127.0.0.1:3000"` and reload the extension.
   Set it back before running `build:zip`.

## 3. Hosted configuration (Vercel → Settings → Environment Variables)

| Variable | What |
|---|---|
| `PUBLIC_URL` | `https://applyflow-ai-murex.vercel.app` (Gmail redirect + cron target) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase project + **secret** key (server only) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth **Web application** client; redirect `<PUBLIC_URL>/auth/google/callback` |
| `CRON_SECRET` | shared secret for `/internal/send-due` and `/internal/warm` (the server copies it into Supabase on start) |

Never set `GROQ_API_KEY` / `GEMINI_API_KEY` on Vercel, or every tester would use your key. Testers paste their own key in Settings.

**Adding a tester for Gmail:** Google Cloud → Google Auth Platform → Audience → **Test users** → add their Gmail
address (up to 100 while the app is in testing; sign-ins last 7 days).

## 4. Security & privacy
- Each tester's data is reachable only with their random tester ID; the database has Row Level Security
  on with no public policies, and only the backend's secret key can read it.
- Groq/Gemini keys are stored per tester and only ever shown back masked (`gsk_…a1b2`).
- Gmail: `gmail.send` only (no inbox access); tokens per tester; sign-in uses PKCE + one-time `state`.
- LinkedIn posts are treated as untrusted input (prompt-injection defences + output validation).
- Edits, sends and schedules carry the version they were based on; out-of-date pages get `409 STALE`
  instead of overwriting newer changes.
- Scheduled sends are claimed atomically and an interrupted send is never retried automatically.

## 5. Before a public launch (future)
- Google OAuth verification (removes the tester list and the 7-day reconnects)
- Chrome Web Store listing (removes Developer mode)
- Vercel Pro if ApplyFlow becomes a commercial product
