// ==========================================
// SCHEDULED EMAILS ("Send later")
// ==========================================
// The application keeps the email (still editable until it goes out) and a small
// `schedule` note: { jobId, sendAt, status: "scheduled" | "failed", error, allowDuplicate }.
// The JOB (who / which application / when) lives in a shared queue:
//  - Supabase table applyflow_schedule (hosted). pg_cron checks it every minute and
//    calls POST /internal/send-due only when something is due (see the migration).
//  - A JSON document in the "_schedule" space (your PC + tests), checked every 30s
//    by startLocalScheduler().
// runDueJobs() claims due jobs atomically, sends each one as its tester, and copies
// the result (sent / failed + reason) back onto the application.
import crypto from "node:crypto";
import { USING_SUPABASE, supabaseClient, readJson, updateJson } from "./store.js";
import { runAsUser, currentUserId } from "./context.js";
import { getApplication, modifyApplication } from "./applications.js";
import { getResume } from "./resumes.js";
import * as gmail from "./gmail.js";
import { sendApplication, assertNotDuplicate, SendError } from "./sender.js";

export const MIN_LEAD_MS = 60 * 1000;                 // at least 1 minute ahead
export const MAX_AHEAD_MS = 6 * 24 * 60 * 60 * 1000;  // at most 6 days ahead
const GMAIL_TEST_TOKEN_DAYS = 7;                       // Google "Testing" apps: sign-ins last 7 days
const MAX_PER_RUN = 10;
const STALE_SENDING_MS = 5 * 60 * 1000;

// ------------------------------------------
// Queue drivers
// ------------------------------------------
const LOCAL = { user: "_schedule" };
const LOCAL_EMPTY = { jobs: [] };

const fileQueue = {
  async add(job) {
    await updateJson("jobs", LOCAL_EMPTY, (db) => {
      for (const j of db.jobs) {
        if (j.user_id === job.user_id && j.application_id === job.application_id && j.status === "scheduled") j.status = "cancelled";
      }
      db.jobs.push(job);
      db.jobs = db.jobs.filter(j => ["scheduled", "sending"].includes(j.status) || !j.app_synced || Date.now() - Date.parse(j.updated_at) < 864e5);
      return { value: db, result: null };
    }, LOCAL);
  },
  async cancel(userId, applicationId) {
    return updateJson("jobs", LOCAL_EMPTY, (db) => {
      let n = 0;
      for (const j of db.jobs) {
        if (j.user_id === userId && j.application_id === applicationId && j.status === "scheduled") { j.status = "cancelled"; n++; }
      }
      return { value: db, result: n };
    }, LOCAL);
  },
  async claimDue(max) {
    return updateJson("jobs", LOCAL_EMPTY, (db) => {
      const now = Date.now();
      for (const j of db.jobs) {
        if (j.status === "sending" && now - Date.parse(j.claimed_at) > STALE_SENDING_MS) {
          Object.assign(j, { status: "failed", last_error: "The send was interrupted. Check your Gmail Sent folder, then retry if it is not there.", updated_at: new Date().toISOString() });
        }
      }
      const due = db.jobs.filter(j => j.status === "scheduled" && Date.parse(j.send_at) <= now)
        .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at)).slice(0, max);
      for (const j of due) Object.assign(j, { status: "sending", claimed_at: new Date().toISOString(), attempts: (j.attempts || 0) + 1 });
      return { value: db, result: due.map(j => ({ ...j })) };
    }, LOCAL);
  },
  async finish(id, status, error = null) {
    await updateJson("jobs", LOCAL_EMPTY, (db) => {
      const j = db.jobs.find(x => x.id === id);
      if (j) Object.assign(j, { status, last_error: error, app_synced: true, updated_at: new Date().toISOString() });
      return { value: db, result: null };
    }, LOCAL);
  },
  async unsyncedFailures() {
    return (await readJson("jobs", LOCAL_EMPTY, LOCAL)).jobs.filter(j => j.status === "failed" && !j.app_synced);
  }
};

function queueError(action, error) {
  console.error(`ApplyFlow AI: schedule ${action} failed: ${error?.message || error}`);
  return new SendError("STORAGE_ERROR", "The ApplyFlow database is not responding. Please try again.", 503);
}

const supabaseQueue = {
  async add(job) {
    const db = await supabaseClient();
    let r = await db.from("applyflow_schedule").update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("user_id", job.user_id).eq("application_id", job.application_id).eq("status", "scheduled");
    if (r.error) throw queueError("cancel", r.error);
    r = await db.from("applyflow_schedule").insert(job);
    if (r.error?.code === "23505") throw new SendError("ALREADY_SENDING", "This application is being sent right now.", 409);
    if (r.error) throw queueError("insert", r.error);
  },
  async cancel(userId, applicationId) {
    const r = await (await supabaseClient()).from("applyflow_schedule")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("application_id", applicationId).eq("status", "scheduled").select("id");
    if (r.error) throw queueError("cancel", r.error);
    return r.data.length;
  },
  async claimDue(max) {
    const r = await (await supabaseClient()).rpc("applyflow_claim_due", { max_jobs: max });
    if (r.error) throw queueError("claim", r.error);
    return r.data || [];
  },
  async finish(id, status, error = null) {
    const r = await (await supabaseClient()).from("applyflow_schedule")
      .update({ status, last_error: error, app_synced: true, updated_at: new Date().toISOString() }).eq("id", id);
    if (r.error) throw queueError("finish", r.error);
  },
  async unsyncedFailures() {
    const r = await (await supabaseClient()).from("applyflow_schedule")
      .select("*").eq("status", "failed").eq("app_synced", false).limit(50);
    if (r.error) throw queueError("read", r.error);
    return r.data;
  }
};

const queue = () => (USING_SUPABASE ? supabaseQueue : fileQueue);

// ------------------------------------------
// Schedule / cancel (called by the tester)
// ------------------------------------------
/** Parse and check the chosen time. Returns a Date. */
export function checkSendAt(value, now = Date.now()) {
  const when = new Date(value);
  if (!value || Number.isNaN(when.getTime())) throw new SendError("BAD_TIME", "Please pick a valid date and time.");
  if (when.getTime() < now + MIN_LEAD_MS - 5000) throw new SendError("BAD_TIME", "Please pick a time at least 1 minute from now.");
  if (when.getTime() > now + MAX_AHEAD_MS) throw new SendError("BAD_TIME", "You can schedule up to 6 days ahead.");
  return when;
}

/** A warning if the tester's Gmail sign-in may run out before the send time. */
export async function gmailExpiryWarning(sendAt) {
  const status = await gmail.getStatus();
  if (!status.connectedAt) return null;
  const expires = Date.parse(status.connectedAt) + GMAIL_TEST_TOKEN_DAYS * 864e5;
  if (sendAt.getTime() < expires - 60 * 60 * 1000) return null;
  return "Your Gmail connection may expire before then (test apps must reconnect every 7 days). " +
    "Reconnect Gmail in Settings now to be safe.";
}

export async function scheduleApplication({ id, to, subject, body, resumeId, sendAt, allowDuplicate = false }) {
  const when = checkSendAt(sendAt);
  const status = await gmail.getStatus();
  if (!status.connected) throw new SendError("GMAIL_NOT_CONNECTED", "Connect your Gmail in Settings before scheduling an email.", 401);

  const record = await getApplication(id);
  if (!record) throw new SendError("NOT_FOUND", "Application not found.", 404);
  if (!allowDuplicate) await assertNotDuplicate(record);
  if (!(await getResume(resumeId))) throw new SendError("NO_RESUME", "Please choose a resume to attach.");
  gmail.buildMimeMessage({ to, subject, body }); // same checks as sending: valid address, subject, body

  const job = {
    id: crypto.randomUUID(),
    user_id: currentUserId(),
    application_id: id,
    send_at: when.toISOString(),
    status: "scheduled",
    allow_duplicate: !!allowDuplicate,
    attempts: 0,
    app_synced: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await queue().add(job);

  const updated = await modifyApplication(id, (a) => {
    a.email = { ...(a.email || {}), to: String(to).trim(), subject, body, resumeId };
    a.resumeId = resumeId;
    if (a.status !== "Scheduled") a.statusBeforeSchedule = a.status;
    a.status = "Scheduled";
    a.schedule = { jobId: job.id, sendAt: job.send_at, status: "scheduled", error: null, allowDuplicate: !!allowDuplicate };
    a.history.push({ at: job.created_at, event: `email scheduled for ${job.send_at}` });
  });
  return { application: updated, warning: await gmailExpiryWarning(when) };
}

/** Cancel a scheduled email (or clear a failed one). The email itself is kept. */
export async function cancelSchedule(id, { reason = "schedule cancelled" } = {}) {
  await queue().cancel(currentUserId(), id);
  return modifyApplication(id, (a) => {
    if (!a.schedule) return;
    if (a.status === "Scheduled") a.status = a.statusBeforeSchedule && a.statusBeforeSchedule !== "Scheduled" ? a.statusBeforeSchedule : "Ready to Apply";
    a.schedule = null;
    a.history.push({ at: new Date().toISOString(), event: reason });
  });
}

// ------------------------------------------
// The runner (cron → /internal/send-due, or the local timer)
// ------------------------------------------
async function markFailed(job, message) {
  await runAsUser(job.user_id, () => modifyApplication(job.application_id, (a) => {
    if (a.schedule?.jobId !== job.id) return;   // rescheduled/cancelled meanwhile
    if (a.status === "Scheduled") a.status = a.statusBeforeSchedule && a.statusBeforeSchedule !== "Scheduled" ? a.statusBeforeSchedule : "Ready to Apply";
    a.schedule = { ...a.schedule, status: "failed", error: message, failedAt: new Date().toISOString() };
    a.history.push({ at: new Date().toISOString(), event: `scheduled email NOT sent: ${message}` });
  })).catch(() => {}); // application deleted: nothing to update
}

function friendlyFailure(error) {
  if (error.code === "GMAIL_RECONNECT" || error.code === "GMAIL_NOT_CONNECTED") {
    return "Gmail access expired. Reconnect Gmail in Settings, then press Retry.";
  }
  if (error.code === "DUPLICATE") return "You had already applied to this opening, so it wasn't sent again.";
  return error.message || "Sending failed.";
}

async function sendJob(job) {
  return runAsUser(job.user_id, async () => {
    const app = await getApplication(job.application_id);
    if (!app || app.schedule?.jobId !== job.id) return "skipped";   // deleted / rescheduled
    const email = app.email || {};
    await sendApplication({
      id: app.id, to: email.to, subject: email.subject, body: email.body,
      resumeId: app.resumeId || email.resumeId, allowDuplicate: job.allow_duplicate, scheduled: true
    });
    return "sent";
  });
}

/** Send every due job. Returns { sent, failed, skipped }. Safe to run in parallel. */
export async function runDueJobs() {
  const q = queue();
  const result = { sent: 0, failed: 0, skipped: 0 };

  // Jobs the database marked failed (interrupted sends): copy that onto the application.
  for (const job of await q.unsyncedFailures()) {
    await markFailed(job, job.last_error || "Sending failed.");
    await q.finish(job.id, "failed", job.last_error);
    result.failed++;
  }

  for (;;) {
    const jobs = await q.claimDue(MAX_PER_RUN);
    if (!jobs.length) break;
    for (const job of jobs) {
      try {
        const outcome = await sendJob(job);
        await q.finish(job.id, outcome === "sent" ? "sent" : "cancelled");
        result[outcome]++;
      } catch (error) {
        const message = friendlyFailure(error);
        console.warn(`ApplyFlow AI: scheduled send failed [${error.code || "ERROR"}]: ${error.message}`);
        await markFailed(job, message);
        await q.finish(job.id, "failed", message);
        result.failed++;
      }
    }
    if (jobs.length < MAX_PER_RUN) break;
  }
  if (result.sent || result.failed) console.log(`ApplyFlow AI: scheduler run - ${JSON.stringify(result)}`);
  return result;
}

/** On your PC (no pg_cron): check the queue every 30 seconds. */
export function startLocalScheduler(everyMs = 30000) {
  const timer = setInterval(() => runDueJobs().catch(e => console.error(`ApplyFlow AI: scheduler: ${e.message}`)), everyMs);
  timer.unref?.();
  return timer;
}

/**
 * Remove a pending schedule without touching the status — used after "Send now"
 * and when the user changes the status by hand.
 */
export async function dropSchedule(id) {
  await queue().cancel(currentUserId(), id);
  return modifyApplication(id, (a) => {
    if (a.schedule) a.schedule = null;
  }).catch(() => null);
}

/**
 * Tell the database where to call and with which secret (hosted only). Runs once per
 * server start; the values come from Vercel's PUBLIC_URL and CRON_SECRET settings,
 * so nothing secret is ever stored in git.
 */
export async function syncCronConfig() {
  if (!USING_SUPABASE || !process.env.CRON_SECRET || !process.env.PUBLIC_URL) return false;
  const rows = [
    { key: "public_url", value: process.env.PUBLIC_URL.replace(/\/+$/, ""), updated_at: new Date().toISOString() },
    { key: "cron_secret", value: process.env.CRON_SECRET, updated_at: new Date().toISOString() }
  ];
  const r = await (await supabaseClient()).from("applyflow_config").upsert(rows, { onConflict: "key" });
  if (r.error) throw queueError("config", r.error);
  return true;
}
