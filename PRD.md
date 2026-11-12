# ApplyFlow AI — Product Requirements Document

| | |
|---|---|
| **Product** | ApplyFlow AI — an AI assistant for applying to LinkedIn hiring posts |
| **Status** | v2.2 — shipped for personal use, tested end-to-end |
| **Platform** | Chrome extension (Manifest V3) + local Node.js backend |
| **AI** | Google Gemini (with automatic model fallback) |
| **Last updated** | November 2026 |

---

## 1. The problem

On LinkedIn many of the best openings don't appear as formal job listings. They show up as **feed posts**:
*"We're hiring a backend engineer, send your resume to jobs@company.com"*. Applying to them is
slow and repetitive:

1. **They're easy to miss.** Hiring posts are mixed in with everything else in the feed.
2. **Pulling out the details is manual.** Role, company, required experience and the contact email are buried in free text.
3. **Choosing a resume takes thought.** A candidate with several resumes (e.g. backend, frontend, data) has to decide which one fits.
4. **Writing a good email takes 10–15 minutes.** Generic copy-paste emails get ignored, while personalised ones take time.
5. **Sending is fiddly.** You open Gmail, paste the address, write a subject, attach the right PDF and check everything again.
6. **It's hard to keep track.** After a few dozen applications you can't remember who you emailed or whether you've already applied.

Because of all this, a job seeker can realistically apply to only a handful of posts a day, and
the quality of each email drops as fatigue sets in.

## 2. Who it's for

**Primary user:** an active job seeker (student, new graduate or early-career engineer) who:
- scrolls LinkedIn daily and sees hiring posts with an email to apply,
- keeps 2–5 tailored resumes,
- wants each email to sound personal and professional, not AI-generic,
- wants to stay in control: **nothing is sent without their approval.**

## 3. Goals and non-goals

### Goals
| # | Goal | Success measure |
|---|---|---|
| G1 | Detect hiring posts automatically while the user scrolls | Card appears on genuine hiring posts; ignores regular posts |
| G2 | Extract the job details reliably | Title, company, recruiter, email and experience shown correctly in the panel |
| G3 | Pick the best-matching resume | Match score + reason shown; user can override |
| G4 | Draft a personalised, human-sounding email | User sends with only light edits |
| G5 | Send from the user's own Gmail with the resume attached | Email arrives with the correct PDF |
| G6 | Make it fast | Draft ready in **under ~5 seconds** |
| G7 | Keep the user in control and keep their data private | Two-click Send → Confirm; data stays on the user's machine |
| G8 | Track applications | History with status and duplicate warnings |

### Non-goals (for this version)
- Auto-applying without the user's review ("spray and pray").
- LinkedIn "Easy Apply" forms or other job boards (possible future work).
- Reading the user's inbox. ApplyFlow only has permission to *send* email.
- A public Chrome Web Store release with hosted accounts (see §9).

## 4. User journey

```
Scroll LinkedIn ─▶ "Hiring post detected" card appears
               ─▶ click it ─▶ floating ApplyFlow window opens on the same page
                              • job details (title, company, contact email)
                              • best resume + match score
                              • drafted email (fully editable)
               ─▶ Send application ─▶ Confirm ─▶ sent from Gmail with PDF attached
               ─▶ logged in the Dashboard (Applications · Resumes · Settings)
```

## 5. Functional requirements

| ID | Requirement |
|---|---|
| **F1 — Detection** | The content script watches the LinkedIn feed, finds posts that look like hiring posts and shows an unobtrusive card. |
| **F2 — Job analysis** | The backend sends the post text to Gemini, which returns structured JSON: `isHiringPost`, job title, company, recruiter, email, experience, category. All output is validated and normalised. |
| **F3 — Resume library** | The user uploads PDF resumes (max 5 MB). Text is extracted, and each resume is analysed once into a profile (skills, roles, seniority) that is reused for matching. |
| **F4 — Match + draft in one call** | One Gemini call ranks the resumes against the job and writes the email. It gets the full post and the full resume text, plans the email first, then writes it. |
| **F5 — Writing style** | The user can save their own example email (`styleExample`) plus a name, phone and LinkedIn signature. Drafts follow that tone: warm greeting, ~200 words, "Warm regards, Name \| phone". |
| **F6 — Review and edit** | Recipient, subject, body and chosen resume can all be edited before sending. A full Review page is available for more detail. |
| **F7 — Send via Gmail** | OAuth 2.0 (PKCE) with only the `gmail.send` scope. The email is sent as HTML with the selected resume PDF attached. |
| **F8 — Explicit confirmation** | Sending takes two clicks (**Send application → Confirm**). Nothing is ever sent automatically. |
| **F9 — Tracking** | Every application is stored with a status. Duplicate detection (post hash + company/role key) warns before applying twice. |
| **F10 — Dashboard** | Tabs for application history, the resume library and settings (profile, writing style, Gmail connect/disconnect). |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| **Speed** | The user waits on drafts, so the target is under ~5 s. Cheap, fast "flash-lite" models are preferred. |
| **Reliability** | Gemini models are sometimes overloaded (503), rate-limited (429), slow, or retired (404). The app must keep working when any single model fails. |
| **Privacy** | API keys, resumes, application history and the Gmail token never leave the user's machine (except for the Gemini and Gmail API calls themselves). |
| **Security** | No website other than the extension may call the local API. LinkedIn posts and resumes are treated as untrusted input. |
| **Usability** | Works inside the LinkedIn page without opening new tabs. Clean monochrome design with automatic light/dark mode. |

## 7. How we solved it

### 7.1 Architecture

```
┌──────────────────── Chrome (LinkedIn tab) ────────────────────┐
│ content.js   detects posts, renders the floating window       │
│ background.js service worker: talks to backend, caching,      │
│               timeouts                                         │
│ dashboard / review / popup pages                               │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTP (127.0.0.1:3000 only)
┌───────────────────────────▼───────────────────────────────────┐
│ Node.js + Express backend (server.js)                          │
│  lib/gemini.js   model tiers, fallback, racing, error codes    │
│  lib/ai.js       prompts + output validation                   │
│  lib/resumes.js  PDF validation, text extraction, library      │
│  lib/applications.js  tracking + duplicate detection           │
│  lib/gmail.js    OAuth 2.0 PKCE + MIME builder + send          │
│  lib/store.js    safe JSON storage in backend/data/            │
└──────────┬──────────────────────────────────┬─────────────────┘
           ▼                                  ▼
     Google Gemini API                   Gmail API (send only)
```

**Why a local backend instead of calling Gemini from the extension?** Anything inside an
extension can be read by anyone who installs it. Keeping keys in `backend/.env` on the user's
machine means they're never exposed.

**Choosing the AI provider.** On day one we wrote two quick check scripts:
`backend/test-gemini.js` and `backend/test-openai.js`. We chose **Google Gemini** because its API has a genuinely free tier, which suits a personal project.
OpenAI asked for paid credits before the very first request would work. The product was built
entirely on Gemini, and OpenAI is not used anywhere in the app. `test-openai.js` stays in the repo
only as a record of that early experiment.

### 7.2 Making AI fast and reliable
- **Model tiers** (`lib/gemini.js`):
  - `fast` handles post analysis.
  - `smart` handles the one-time resume analysis, where quality matters more than speed.
  - `draft` handles matching + email, with the fastest model first.

  Each tier is an ordered list of models, configurable in `.env`.
- **Automatic fallback.** On 429/500/503/504 or a retired model (404), the next model in the tier is tried.
- **Racing (hedged requests).** If a model hasn't answered within 5 s, the next model is asked *in parallel* and the first valid answer wins. We added this after a single hung model caused 30-second drafts.
- **One-shot drafting.** Matching and email writing used to be separate calls. Merging them into one call cut draft time from **21.6 s to 3.9 s**.
- **Draft only on click.** Nothing is drafted in the background, which saves API quota.

### 7.3 Email quality
Early drafts were clipped and robotic. Instead of maintaining a list of banned phrases, we let the
user paste an email they like, and the model imitates that style. It also gets the full post and
full resume text, and plans the email before writing it.

### 7.4 Security and privacy
- The backend binds to `127.0.0.1`. **Host-header checks** block DNS-rebinding attacks.
- An **origin allow-list** means only `chrome-extension://` origins (optionally pinned to one extension ID) can call the API, so other websites can't use your quota or read your data.
- **Rate limiting** applies to AI endpoints (40 requests/minute).
- PDF uploads are validated (MIME type, magic bytes, 5 MB limit).
- **Prompt-injection defence.** Gemini is told to ignore instructions inside posts and resumes, and every AI output is schema-checked and normalised.
- Gmail uses OAuth 2.0 with PKCE and only the `gmail.send` scope. ApplyFlow cannot read your mail.
- All personal data lives in `backend/data/`, which is git-ignored.

### 7.5 Design
- **v2.1:** moved from a separate review tab to an in-page panel on LinkedIn.
- **v2.2:** monochrome, Apple-like redesign with:
  - automatic light/dark mode,
  - the bundled Inter font,
  - a paper-plane app icon,
  - a **floating, draggable window** (top-right) instead of a side drawer, so the feed stays visible.

## 8. Release history

| Version | Highlights |
|---|---|
| **V1** | End-to-end flow: LinkedIn detection → Gemini analysis → resume match → email draft → Gmail send with PDF. |
| **v2.1** | In-page side panel, one-shot drafting (21.6 s → 3.9 s), model racing, black + indigo design. |
| **v2.2** | Monochrome light/dark redesign, new icon, floating draggable window, better email quality from the user's style example. |

## 9. Limitations and future work
- **Gmail Testing mode:** the Google OAuth app is in Testing mode, so the Gmail connection expires every 7 days and the user must reconnect.
- **Local only:** a public release needs a hosted backend with user accounts, per-user data isolation, its own Gemini billing and Google's verification for the `gmail.send` scope.
- **Ideas:**
  - require `ALLOWED_EXTENSION_ID` by default,
  - follow-up reminders,
  - support for other job boards (Naukri, Wellfound, Indeed),
  - reply tracking,
  - analytics on response rate per resume.
