// ==========================================
// APPLICATION TRACKING
// ==========================================
// Stored in backend/data/applications.json.
// Duplicate detection uses two keys:
//   postHash — the same LinkedIn post seen again (normalised text)
//   roleKey  — same recruiter email + job title (the same opening re-posted)
import crypto from "node:crypto";
import { readJson, updateJson } from "./store.js";

const EMPTY = { applications: [] };

export const STATUSES = [
  "Detected", "Analysed", "Ready to Apply", "Applied", "Interview", "Rejected", "No Response"
];

export class ApplicationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const clip = (v, max) => (typeof v === "string" ? v.slice(0, max) : v);

export function hashPost(postText) {
  const normalised = String(postText || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")             // tracking links change between loads
    .replace(/\b\d+\s*(?:[smhdw]|mo|yr)\b/g, "") // "3d", "1w" timestamps
    .replace(/[^a-z0-9@.]+/g, " ")
    .trim()
    .slice(0, 3000);
  return crypto.createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

export function roleKey(job) {
  const email = (job?.email || "").toLowerCase().trim();
  const title = (job?.jobTitle || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return email && title ? `${email}|${title}` : null;
}

export async function listApplications() {
  const { applications } = await readJson("applications", EMPTY);
  return applications.sort((a, b) => (b.detectedAt || "").localeCompare(a.detectedAt || ""));
}

export async function getApplication(id) {
  return (await listApplications()).find(a => a.id === id) || null;
}

/** Find earlier applications that look like the same opening. */
export async function findDuplicates(app) {
  const key = roleKey(app.job);
  return (await listApplications())
    .filter(a => a.id !== app.id && (a.postHash === app.postHash || (key && roleKey(a.job) === key)))
    .map(a => ({ id: a.id, status: a.status, appliedAt: a.appliedAt, jobTitle: a.job?.jobTitle, company: a.job?.company }));
}

/**
 * Create a record for a detected post, or update the existing one
 * (same post seen again). Never downgrades the status of an existing record.
 */
export async function upsertFromPost({ postText, sourceUrl, job, analysedWith, analysisSource }) {
  const postHash = hashPost(postText);
  const now = new Date().toISOString();

  return updateJson("applications", EMPTY, (db) => {
    let app = db.applications.find(a => a.postHash === postHash);
    if (app) {
      // Prefer AI data over local fallback data; never overwrite AI data with local data.
      if (job && (analysisSource === "gemini" || app.analysisSource !== "gemini")) {
        app.job = { ...job };
        app.analysisSource = analysisSource;
        app.analysedWith = analysedWith || null;
      }
      if (sourceUrl && !app.sourceUrl) app.sourceUrl = clip(sourceUrl, 500);
      app.lastSeenAt = now;
      if (app.status === "Detected" && job) app.status = "Analysed";
      return { value: db, result: app };
    }

    app = {
      id: crypto.randomUUID(),
      postHash,
      postText: clip(postText, 10000),
      sourceUrl: clip(sourceUrl, 500) || null,
      job: job ? { ...job } : null,
      analysisSource: analysisSource || null,
      analysedWith: analysedWith || null,
      status: job ? "Analysed" : "Detected",
      detectedAt: now,
      lastSeenAt: now,
      appliedAt: null,
      match: null,
      resumeId: null,
      email: null,       // { to, subject, body, generatedWith }
      sentMessageId: null,
      notes: "",
      history: [{ at: now, event: "detected" }]
    };
    db.applications.push(app);
    return { value: db, result: app };
  });
}

/** Apply a change to one application. `mutate(app)` edits it in place. */
export function modifyApplication(id, mutate) {
  return updateJson("applications", EMPTY, async (db) => {
    const app = db.applications.find(a => a.id === id);
    if (!app) throw new ApplicationError("NOT_FOUND", "Application not found.", 404);
    await mutate(app);
    return { value: db, result: app };
  });
}

/** Safe user edits from the review page / dashboard. */
export function editApplication(id, changes) {
  return modifyApplication(id, (app) => {
    if (changes.status !== undefined) {
      if (!STATUSES.includes(changes.status)) throw new ApplicationError("BAD_STATUS", "Unknown status.");
      if (changes.status !== app.status) {
        app.history.push({ at: new Date().toISOString(), event: `status: ${app.status} → ${changes.status}` });
        app.status = changes.status;
        if (changes.status === "Applied" && !app.appliedAt) app.appliedAt = new Date().toISOString();
      }
    }
    if (typeof changes.notes === "string") app.notes = changes.notes.slice(0, 5000);
    if (typeof changes.resumeId === "string") app.resumeId = changes.resumeId;
    if (changes.email && typeof changes.email === "object") {
      app.email = {
        ...(app.email || {}),
        ...(typeof changes.email.to === "string" ? { to: changes.email.to.trim().slice(0, 200) } : {}),
        ...(typeof changes.email.subject === "string" ? { subject: changes.email.subject.replace(/[\r\n]+/g, " ").slice(0, 300) } : {}),
        ...(typeof changes.email.body === "string" ? { body: changes.email.body.slice(0, 20000) } : {})
      };
    }
    if (changes.job && typeof changes.job === "object" && app.job) {
      for (const k of ["jobTitle", "company", "recruiter", "email"]) {
        if (typeof changes.job[k] === "string") app.job[k] = changes.job[k].trim().slice(0, 200) || null;
      }
    }
  });
}

export async function deleteApplication(id) {
  return updateJson("applications", EMPTY, (db) => {
    const index = db.applications.findIndex(a => a.id === id);
    if (index === -1) throw new ApplicationError("NOT_FOUND", "Application not found.", 404);
    db.applications.splice(index, 1);
    return { value: db, result: { id } };
  });
}
