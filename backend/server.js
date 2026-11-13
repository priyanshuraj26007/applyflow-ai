// ==========================================
// APPLYFLOW AI — BACKEND (hosted on Vercel, or on your own PC)
// ==========================================
// One backend shared by all testers. Every /api request carries the tester's
// random ID (X-ApplyFlow-User header, made by the extension on install) and only
// ever touches that tester's data. Routes only — the real work lives in ./lib:
//   context.js       which tester is making this request + background work
//   ai-router.js     AI providers (Groq, Gemini), racing, fallbacks, retries
//   gemini.js/groq.js one request to one provider
//   ai.js            prompts + validation (job, resume, match, email)
//   resumes.js       PDF upload/validation/extraction + resume library
//   applications.js  application tracking + duplicate detection
//   gmail.js         OAuth 2.0 + sending with attachment
//   settings.js      sender profile + writing preferences
//   store.js         per-tester storage: Supabase when hosted, files on your PC
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";

import { callAI, aiKeys, MODEL_TIERS, PROVIDER_ORDER } from "./lib/ai-router.js";
import { runAsUser, LOCAL_USER, USER_ID_RE, currentUserId, background } from "./lib/context.js";
import { USING_SUPABASE } from "./lib/store.js";
import { analyzeJobPost, matchResumes, writeEmail, draftApplication, normaliseJob, DEFAULT_EMAIL_SKELETON } from "./lib/ai.js";
import { ABOUT_ME_PROMPT, aboutMeState, ensureCondensed, aboutMeForPrompt } from "./lib/about-me.js";
import {
  listResumes, getResume, addResume, replaceResumeFile, editResume, deleteResume,
  analyseAndSave, publicResume, readResumeFile, MAX_RESUME_BYTES
} from "./lib/resumes.js";
import {
  listApplications, getApplication, upsertFromPost, modifyApplication, editApplication,
  deleteApplication, findDuplicates, STATUSES
} from "./lib/applications.js";
import * as gmail from "./lib/gmail.js";
import { getSettings, saveSettings, publicSettings } from "./lib/settings.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Hosted = running on Vercel (or any server with a public address in PUBLIC_URL).
const HOSTED = Boolean(process.env.VERCEL || process.env.PUBLIC_URL);
const PUBLIC_ORIGIN = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// Optional: lock the API to your extension's ID (chrome://extensions → ApplyFlow AI → ID).
const EXTENSION_ID = (process.env.ALLOWED_EXTENSION_ID || "").trim();

// ------------------------------------------
// SECURITY
// ------------------------------------------
app.disable("x-powered-by");

// 1. On your PC: block DNS-rebinding attacks — only answer requests addressed to this machine.
app.use((req, res, next) => {
  if (!HOSTED && !ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(403).json({ success: false, errorCode: "BAD_HOST", error: "Forbidden host." });
  }
  next();
});

// 2. Only the ApplyFlow extension (and this server's own pages) may call the API.
//    Without this, any website you visit could use your Gemini quota or read your data.
function isAllowedOrigin(origin) {
  if (!origin) return true; // PowerShell/curl tests and normal page navigations
  if (origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`) return true;
  if (PUBLIC_ORIGIN && origin === PUBLIC_ORIGIN) return true;
  if (origin.startsWith("chrome-extension://")) {
    return !EXTENSION_ID || origin === `chrome-extension://${EXTENSION_ID}`;
  }
  return false;
}
app.use((req, res, next) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    console.warn(`ApplyFlow AI: blocked request from origin ${req.headers.origin}`);
    return res.status(403).json({ success: false, errorCode: "FORBIDDEN_ORIGIN", error: "Origin not allowed." });
  }
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }));
app.use(express.json({ limit: "200kb" }));

// 3. Which tester is this? Every /api request runs inside that tester's own data space.
//    On your PC the header is optional (curl tests use the "local" space).
app.use("/api", (req, res, next) => {
  const id = req.headers["x-applyflow-user"];
  if (id === undefined && !HOSTED) return runAsUser(LOCAL_USER, next);
  if (typeof id !== "string" || !USER_ID_RE.test(id)) {
    return res.status(401).json({
      success: false, errorCode: "NO_USER_ID",
      error: "This copy of ApplyFlow has no tester ID. Reload the extension in chrome://extensions."
    });
  }
  runAsUser(id, next);
});

// 4. Simple in-memory rate limiting (per tester) for endpoints that spend AI quota.
function rateLimit(max, windowMs) {
  const hitsByUser = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const user = currentUserId();
    const hits = (hitsByUser.get(user) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ success: false, errorCode: "LOCAL_RATE_LIMIT", error: "Too many AI requests. Please wait a minute." });
    }
    hits.push(now);
    hitsByUser.set(user, hits);
    if (hitsByUser.size > 5000) hitsByUser.clear();
    next();
  };
}
const aiLimiter = rateLimit(40, 60_000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf" ||
      (file.mimetype === "application/octet-stream" && /\.pdf$/i.test(file.originalname));
    cb(ok ? null : Object.assign(new Error("Only PDF files are allowed."), { status: 400, code: "INVALID_FILE" }), ok);
  }
});
const singlePdf = (req, res, next) => upload.single("file")(req, res, (err) => {
  if (err?.code === "LIMIT_FILE_SIZE") return next(Object.assign(new Error(`Resume must be ${MAX_RESUME_BYTES / 1024 / 1024} MB or smaller.`), { status: 413, code: "FILE_TOO_LARGE" }));
  next(err);
});

// Wrap async route handlers so errors reach the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isNonEmptyString = (v, min = 1) => typeof v === "string" && v.trim().length >= min;

// ------------------------------------------
// HEALTH + STATUS
// ------------------------------------------
const health = (req, res) => res.json({ success: true, message: "ApplyFlow AI backend is running!" });
app.get("/", health);         // on Vercel the website (public/index.html) is shown at / instead
app.get("/health", health);

app.get("/api/status", route(async (req, res) => {
  const [resumes, applications, gmailStatus, keys] = await Promise.all([listResumes(), listApplications(), gmail.getStatus(), aiKeys()]);
  res.json({
    success: true,
    models: MODEL_TIERS,
    aiKeys: { groq: Boolean(keys.groq), gemini: Boolean(keys.gemini) },
    resumes: resumes.length,
    analysedResumes: resumes.filter(r => r.profile).length,
    applications: applications.length,
    applied: applications.filter(a => a.appliedAt).length,
    gmail: gmailStatus
  });
}));

// ?provider=groq|gemini tests just that key (used right after a key is saved).
app.get("/api/test-gemini", aiLimiter, route(async (req, res) => {
  const only = ["groq", "gemini"].includes(req.query.provider) ? req.query.provider : undefined;
  console.log(`ApplyFlow AI: Sending test request to the AI${only ? ` (${only})` : ""}...`);
  const result = await callAI("fast", "Reply with exactly: ApplyFlow AI connected successfully!", {}, { only });
  res.json({
    success: true,
    message: result.text,
    model: result.model,
    responseTime: `${(result.durationMs / 1000).toFixed(2)} seconds`
  });
}));

// ------------------------------------------
// JOB POST ANALYSIS
// ------------------------------------------
app.post("/api/analyze-job", aiLimiter, route(async (req, res) => {
  const { postText, sourceUrl } = req.body || {};

  if (!postText || typeof postText !== "string") {
    return res.status(400).json({ success: false, error: "Please provide valid LinkedIn post text." });
  }
  if (postText.trim().length < 30) {
    return res.status(400).json({ success: false, error: "The LinkedIn post is too short to analyse." });
  }

  console.log("ApplyFlow AI: Analysing LinkedIn job post...");
  const text = postText.slice(0, 10000);
  const { job, model } = await analyzeJobPost(text);

  let applicationId = null;
  let duplicates = [];
  if (job.isHiringPost) {
    const record = await upsertFromPost({
      postText: text, sourceUrl: safeUrl(sourceUrl), job, analysedWith: model, analysisSource: "gemini"
    });
    applicationId = record.id;
    duplicates = (await findDuplicates(record)).filter(d => d.appliedAt);
  }

  console.log(`ApplyFlow AI: Job analysis completed (${model}).`);
  res.json({ success: true, model, job, applicationId, alreadyApplied: duplicates.length > 0 || undefined });
}));

function safeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)linkedin\.com$/.test(url.hostname) ? url.href.slice(0, 500) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------
// APPLICATIONS
// ------------------------------------------
app.get("/api/applications", route(async (req, res) => {
  const apps = await listApplications();
  res.json({
    success: true,
    statuses: STATUSES,
    applications: apps.map(({ postText, history, ...rest }) => rest)
  });
}));

// Create a record from locally-extracted data (used when Gemini was unavailable).
app.post("/api/applications", route(async (req, res) => {
  const { postText, sourceUrl, job } = req.body || {};
  if (!isNonEmptyString(postText, 30)) {
    return res.status(400).json({ success: false, error: "Post text is required." });
  }
  const record = await upsertFromPost({
    postText: postText.slice(0, 10000),
    sourceUrl: safeUrl(sourceUrl),
    job: job ? normaliseJob({ ...job, isHiringPost: true }) : null,
    analysisSource: "local"
  });
  res.json({ success: true, application: record });
}));

app.get("/api/applications/:id", route(async (req, res) => {
  const record = await getApplication(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "Application not found." });
  res.json({ success: true, application: record, duplicates: await findDuplicates(record), statuses: STATUSES });
}));

app.patch("/api/applications/:id", route(async (req, res) => {
  res.json({ success: true, application: await editApplication(req.params.id, req.body || {}) });
}));

app.delete("/api/applications/:id", route(async (req, res) => {
  res.json({ success: true, ...(await deleteApplication(req.params.id)) });
}));

// Match resumes + draft the email. Body: { resumeId?, rematch?, regenerateEmail? }
app.post("/api/applications/:id/prepare", aiLimiter, route(async (req, res) => {
  const { resumeId, rematch, regenerateEmail } = req.body || {};
  let record = await getApplication(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "Application not found." });

  // If this record only has local (regex) data, try Gemini once more.
  if (record.analysisSource !== "gemini") {
    try {
      const { job, model } = await analyzeJobPost(record.postText);
      record = await modifyApplication(record.id, (a) => {
        a.job = job; a.analysisSource = "gemini"; a.analysedWith = model;
        if (a.status === "Detected") a.status = "Analysed";
      });
    } catch (error) {
      console.warn(`ApplyFlow AI: re-analysis still failing [${error.code}] - using local data.`);
    }
  }
  if (!record.job) {
    return res.status(422).json({ success: false, errorCode: "NO_JOB_DATA", error: "No job details available for this post yet." });
  }

  const resumes = await listResumes();
  const analysed = resumes.filter(r => r.profile);
  if (!analysed.length) {
    return res.status(400).json({
      success: false, errorCode: "NO_RESUMES",
      error: resumes.length
        ? "Your resumes are still being analysed (or analysis failed). Check the Resumes tab in the dashboard."
        : "Upload at least one resume in the dashboard first."
    });
  }

  const exists = (id) => analysed.some(r => r.id === id);
  const libraryKey = analysed.map(r => `${r.id}:${r.hash}`).sort().join(",");
  const userChoice = (exists(resumeId) && resumeId) || (exists(record.resumeId) && record.resumeId) || null;
  const needMatch = rematch || !record.match || record.match.libraryKey !== libraryKey;
  const emailFor = (id) => !regenerateEmail && record.email?.body && record.email.resumeId === id;
  const settings = await getSettings();
  const now = () => new Date().toISOString();
  const makeEmail = (generated, forResumeId) => ({
    to: record.email?.to || record.job.email || "",
    subject: generated.subject,
    body: generated.body,
    eligibility: generated.eligibility || null,
    resumeId: forResumeId,
    generatedWith: generated.model,
    generatedAt: now()
  });

  const profileText = await aboutMeForPrompt(settings);
  let match = record.match;
  let email = record.email;
  let chosenId;
  const started = Date.now();

  if (needMatch && !(userChoice && emailFor(userChoice))) {
    // Score resumes + write the email (in parallel when the resume is already known).
    const draft = await draftApplication({
      job: record.job, postText: record.postText, resumes: analysed, settings, preferredResumeId: userChoice, profileText
    });
    match = { rankings: draft.rankings, recommendedResumeId: draft.recommendedResumeId, model: draft.model, libraryKey, matchedAt: now() };
    chosenId = draft.emailResumeId;
    email = makeEmail(draft, chosenId);
  } else {
    if (needMatch) {
      // Only the scores are stale (e.g. "Re-run matching") — keep the user's email.
      const result = await matchResumes(record.job, analysed);
      match = { ...result, libraryKey, matchedAt: now() };
    }
    // Resume choice — user override > previous choice > AI recommendation.
    chosenId = userChoice || match.recommendedResumeId;
    if (!emailFor(chosenId)) {
      const generated = await writeEmail({
        job: record.job,
        postText: record.postText,
        resume: analysed.find(r => r.id === chosenId),
        settings,
        profileText
      });
      email = makeEmail(generated, chosenId);
    }
  }
  console.log(`ApplyFlow AI: application prepared in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

  record = await modifyApplication(record.id, (a) => {
    a.match = match;
    a.resumeId = chosenId;
    a.email = email;
    if (["Detected", "Analysed"].includes(a.status)) {
      a.status = "Ready to Apply";
      a.history.push({ at: new Date().toISOString(), event: "prepared" });
    }
  });

  res.json({ success: true, application: record, duplicates: await findDuplicates(record) });
}));

// Send — ONLY ever triggered by the user clicking "Send Application".
const sending = new Set();
app.post("/api/applications/:id/send", route(async (req, res) => {
  const { to, subject, body, resumeId, confirm, allowDuplicate } = req.body || {};
  const id = req.params.id;
  const sendKey = `${currentUserId()}:${id}`;

  if (confirm !== true) {
    return res.status(400).json({ success: false, errorCode: "NOT_CONFIRMED", error: "Sending requires explicit confirmation." });
  }
  if (sending.has(sendKey)) {
    return res.status(409).json({ success: false, errorCode: "ALREADY_SENDING", error: "This application is already being sent." });
  }

  sending.add(sendKey);
  try {
    const record = await getApplication(id);
    if (!record) return res.status(404).json({ success: false, error: "Application not found." });

    if (!allowDuplicate) {
      const earlier = (await findDuplicates(record)).filter(d => d.appliedAt);
      if (record.sentMessageId || earlier.length) {
        return res.status(409).json({
          success: false, errorCode: "DUPLICATE",
          error: "You have already applied to this opening. Send again anyway?",
          duplicates: earlier
        });
      }
    }

    const resume = await getResume(resumeId);
    if (!resume) return res.status(400).json({ success: false, errorCode: "NO_RESUME", error: "Please choose a resume to attach." });

    const content = await readResumeFile(resume);
    const filename = resume.originalName || `${resume.label}.pdf`;

    const result = await gmail.sendEmail({ to, subject, body, attachment: { filename, content } });

    const updated = await modifyApplication(id, (a) => {
      const now = new Date().toISOString();
      a.email = { ...(a.email || {}), to: String(to).trim(), subject, body, resumeId };
      a.resumeId = resumeId;
      a.status = "Applied";
      a.appliedAt = now;
      a.sentMessageId = result.messageId;
      a.history.push({ at: now, event: `email sent to ${String(to).trim()} with ${resume.label}` });
    });

    console.log(`ApplyFlow AI: application sent (${updated.job?.jobTitle || "role"}).`);
    res.json({ success: true, application: updated });
  } finally {
    sending.delete(sendKey);
  }
}));

// ------------------------------------------
// RESUME LIBRARY
// ------------------------------------------
app.get("/api/resumes", route(async (req, res) => {
  res.json({ success: true, resumes: (await listResumes()).map(publicResume) });
}));

app.post("/api/resumes", singlePdf, route(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, errorCode: "NO_FILE", error: "Please choose a PDF file." });
  const resume = await addResume({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    label: req.body?.label,
    category: req.body?.category
  });
  background(analyseAndSave(resume.id)); // runs after the response; dashboard polls
  res.status(201).json({ success: true, resume });
}));

app.put("/api/resumes/:id/file", singlePdf, route(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, errorCode: "NO_FILE", error: "Please choose a PDF file." });
  const resume = await replaceResumeFile(req.params.id, { buffer: req.file.buffer, originalName: req.file.originalname });
  background(analyseAndSave(resume.id));
  res.json({ success: true, resume });
}));

app.patch("/api/resumes/:id", route(async (req, res) => {
  const { label, category, isDefault } = req.body || {};
  res.json({ success: true, resume: await editResume(req.params.id, { label, category, isDefault }) });
}));

app.post("/api/resumes/:id/analyze", aiLimiter, route(async (req, res) => {
  res.json({ success: true, resume: await analyseAndSave(req.params.id) });
}));

app.delete("/api/resumes/:id", route(async (req, res) => {
  res.json({ success: true, ...(await deleteResume(req.params.id)) });
}));

app.get("/api/resumes/:id/file", route(async (req, res) => {
  const resume = await getResume(req.params.id);
  if (!resume) return res.status(404).json({ success: false, error: "Resume not found." });
  const content = await readResumeFile(resume);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${(resume.originalName || "resume.pdf").replace(/"/g, "")}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  res.send(content);
}));

// ------------------------------------------
// SETTINGS
// ------------------------------------------
app.get("/api/settings", route(async (req, res) => {
  const settings = await getSettings();
  res.json({
    success: true, settings: publicSettings(settings),
    aboutMe: await ensureCondensed(settings), // also resumes a condense that stopped or failed earlier
    aboutMePrompt: ABOUT_ME_PROMPT,
    defaultSkeleton: DEFAULT_EMAIL_SKELETON
  });
}));
app.put("/api/settings", route(async (req, res) => {
  const settings = await saveSettings(req.body || {});
  const aboutMeSaved = typeof req.body?.aboutMe === "string";
  res.json({ success: true, settings: publicSettings(settings), aboutMe: await ensureCondensed(settings, { fresh: aboutMeSaved }) });
}));

// ------------------------------------------
// GMAIL OAUTH
// ------------------------------------------
app.get("/api/gmail/status", route(async (req, res) => {
  res.json({ success: true, ...(await gmail.getStatus()) });
}));

// The extension asks for a sign-in link (with its tester ID in the header), then opens it.
app.post("/api/gmail/connect", route(async (req, res) => {
  res.json({ success: true, url: await gmail.buildAuthUrl() });
}));

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { email } = await gmail.handleCallback(req.query);
    res.type("html").send(resultPage(true, `Gmail connected${email ? ` as ${email}` : ""}. You can close this tab and return to ApplyFlow AI.`));
  } catch (error) {
    console.error(`ApplyFlow AI: Gmail connect failed [${error.code}]: ${error.message}`);
    res.status(error.status || 500).type("html").send(resultPage(false, error.message));
  }
});

app.post("/api/gmail/disconnect", route(async (req, res) => {
  await gmail.disconnect();
  res.json({ success: true });
}));

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function resultPage(ok, message) {
  return `<!doctype html><meta charset="utf-8"><title>ApplyFlow AI</title>
<body style="font-family:system-ui,Arial;display:grid;place-items:center;min-height:90vh;background:#f6f7f9;margin:0">
<div style="background:#fff;padding:32px 36px;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.08);max-width:440px;text-align:center">
<div style="font-size:40px">${ok ? "✅" : "⚠️"}</div>
<h2 style="margin:8px 0;color:${ok ? "#166534" : "#9a3412"}">${ok ? "Connected" : "Gmail connection failed"}</h2>
<p style="color:#374151;line-height:1.5">${escapeHtml(message)}</p></div></body>`;
}

// ------------------------------------------
// ERRORS
// ------------------------------------------
app.use((req, res) => {
  res.status(404).json({ success: false, errorCode: "NOT_FOUND", error: "Endpoint not found." });
});

app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, errorCode: "BAD_JSON", error: "Request body is not valid JSON." });
  }
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
  const code = error?.code && typeof error.code === "string" ? error.code : "SERVER_ERROR";
  // Known errors carry safe, user-friendly messages. Unknown ones are logged, not leaked.
  const known = status < 500 || code.startsWith("GEMINI") || code.startsWith("GMAIL") || code.startsWith("STORAGE") || code === "NO_ANALYSED_RESUMES";
  console.error(`ApplyFlow AI error [${code}] ${req.method} ${req.path}: ${error?.message}`);
  if (!known) console.error(error);
  res.status(status === 500 && code.startsWith("GEMINI") ? 502 : status).json({
    success: false,
    errorCode: code,
    error: known ? error.message : "Something went wrong on the ApplyFlow AI backend."
  });
});

// ------------------------------------------
// START
// ------------------------------------------
// On Vercel there is no server to start: Vercel imports `app` and runs it per request.
export default app;

if (!process.env.VERCEL) startLocalServer();

function startLocalServer() {
const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`ApplyFlow AI backend running at http://127.0.0.1:${PORT}`);
  console.log(`Storage: ${USING_SUPABASE ? "Supabase" : "files in backend/data/users"}`);
  console.log(`AI providers: ${PROVIDER_ORDER.join(" → ")}`);
  console.log(`  draft: ${MODEL_TIERS.draft.join(" → ")}`);
  console.log(`  fast:  ${MODEL_TIERS.fast.join(" → ")}`);
  console.log(`  smart: ${MODEL_TIERS.smart.join(" → ")}`);
  if (!gmail.isConfigured()) console.log("Gmail: not configured yet (add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to .env).");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use - ApplyFlow AI may already be running. Stop the other process first.`);
  } else {
    console.error("SERVER ERROR:", error);
  }
  process.exit(1);
});

console.log("ApplyFlow AI: Starting server...");
}
