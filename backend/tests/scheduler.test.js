// Scheduled emails ("Send later") — with a fake Gmail and a throw-away data folder.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.APPLYFLOW_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "applyflow-schedule-test-"));
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { runAsUser } = await import("../lib/context.js");
const { updateJson, writeFile, readJson } = await import("../lib/store.js");
const { upsertFromPost, getApplication, modifyApplication } = await import("../lib/applications.js");
const scheduler = await import("../lib/scheduler.js");

const TESTER = "t".repeat(43);
const OTHER = "o".repeat(43);
const RESUME_ID = "11111111-2222-3333-4444-555555555555";
const as = (fn, user = TESTER) => runAsUser(user, fn);

// ---- Fake Gmail: records every message "sent" ----
let sent = [];
let gmailFails = null;
globalThis.fetch = async (url, options) => {
  if (String(url).includes("gmail.googleapis.com")) {
    if (gmailFails) return new Response(JSON.stringify({ error: { message: "expired" } }), { status: gmailFails });
    sent.push(String(options.body));
    return new Response(JSON.stringify({ id: `msg-${sent.length}`, threadId: "t" }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function setUpTester(user = TESTER) {
  await as(async () => {
    await updateJson("gmail-tokens", null, () => ({ value: {
      refresh_token: "r", access_token: "a", expiry: Date.now() + 3600e3, email: "me@example.com", connectedAt: new Date().toISOString()
    } }));
    await updateJson("resumes", { resumes: [] }, () => ({ value: { resumes: [{
      id: RESUME_ID, label: "Analyst", originalName: "resume.pdf", text: "x", profile: { name: "Me" }, analysisStatus: "done"
    }] } }));
    await writeFile(`${RESUME_ID}.pdf`, Buffer.from("%PDF-1.4 resume"));
  }, user);
}

let n = 0;
async function newApplication(user = TESTER) {
  n++;
  return as(() => upsertFromPost({
    postText: `We are hiring opening number ${n} at Acme. Send your resume to jobs${n}@acme.com — SQL, Excel, dashboards.`,
    job: { isHiringPost: true, jobTitle: `Analyst ${n}`, company: "Acme", email: `jobs${n}@acme.com` }
  }), user);
}

const fields = (app) => ({ id: app.id, to: `hr${n}@acme.com`, subject: "Application", body: "Hi,\n\nI'd like to apply.", resumeId: RESUME_ID });
const inMinutes = (m) => new Date(Date.now() + m * 60e3).toISOString();

/** Pretend the scheduled time has arrived. */
async function makeDue() {
  await updateJson("jobs", { jobs: [] }, (db) => {
    for (const j of db.jobs) if (j.status === "scheduled") j.send_at = new Date(Date.now() - 1000).toISOString();
    return { value: db, result: null };
  }, { user: "_schedule" });
}

beforeEach(async () => { sent = []; gmailFails = null; await setUpTester(); });

test("time rules: at least 1 minute ahead, at most 6 days", () => {
  assert.throws(() => scheduler.checkSendAt("not a date"), { code: "BAD_TIME" });
  assert.throws(() => scheduler.checkSendAt(new Date(Date.now() - 60e3).toISOString()), { code: "BAD_TIME" });
  assert.throws(() => scheduler.checkSendAt(new Date(Date.now() + 7 * 864e5).toISOString()), /6 days/);
  assert.ok(scheduler.checkSendAt(inMinutes(5)) instanceof Date);
  assert.ok(scheduler.checkSendAt(new Date(Date.now() + 5.9 * 864e5).toISOString()));
});

test("schedule → nothing sent early → sent on time, application becomes Applied", async () => {
  const app = await newApplication();
  const { application } = await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(30) }));
  assert.equal(application.status, "Scheduled");
  assert.equal(application.schedule.status, "scheduled");

  assert.deepEqual(await scheduler.runDueJobs(), { sent: 0, failed: 0, skipped: 0 }, "not due yet");
  assert.equal(sent.length, 0);

  await makeDue();
  const run = await scheduler.runDueJobs();
  assert.equal(run.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /resume\.pdf/, "resume attached");
  const after = await as(() => getApplication(app.id));
  assert.equal(after.status, "Applied");
  assert.equal(after.schedule, null);
  assert.ok(after.appliedAt && after.sentMessageId);
});

test("edits made after scheduling are what gets sent", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  await as(() => modifyApplication(app.id, (a) => { a.email.subject = "Edited subject line"; }));
  await makeDue();
  await scheduler.runDueJobs();
  assert.match(sent[0], /Edited subject line/);
});

test("cancel → back to its earlier status and never sent", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  const cancelled = await as(() => scheduler.cancelSchedule(app.id));
  assert.notEqual(cancelled.status, "Scheduled");
  assert.equal(cancelled.schedule, null);
  assert.equal(cancelled.email.subject, "Application", "the email is kept");
  await makeDue();
  await scheduler.runDueJobs();
  assert.equal(sent.length, 0);
});

test("rescheduling replaces the old time (only one send)", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(20) }));
  const jobs = (await readJson("jobs", { jobs: [] }, { user: "_schedule" })).jobs.filter(j => j.application_id === app.id);
  assert.equal(jobs.filter(j => j.status === "scheduled").length, 1);
  await makeDue();
  await scheduler.runDueJobs();
  assert.equal(sent.length, 1);
});

test("two runs at the same moment send the email only once", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  await makeDue();
  const [a, b] = await Promise.all([scheduler.runDueJobs(), scheduler.runDueJobs()]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(sent.length, 1);
});

test("Gmail expired at send time → 'Send failed' with a clear reason, status restored", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  gmailFails = 401;
  await makeDue();
  const run = await scheduler.runDueJobs();
  assert.equal(run.failed, 1);
  const after = await as(() => getApplication(app.id));
  assert.notEqual(after.status, "Scheduled");
  assert.equal(after.schedule.status, "failed");
  assert.match(after.schedule.error, /Reconnect Gmail/);
  assert.ok(!after.appliedAt, "not marked as applied");
});

test("can't schedule without Gmail, and duplicates need confirmation", async () => {
  const app = await newApplication(OTHER);
  await assert.rejects(as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }), OTHER), { code: "GMAIL_NOT_CONNECTED" });

  const done = await newApplication();
  await as(() => modifyApplication(done.id, (a) => { a.sentMessageId = "earlier"; a.appliedAt = new Date().toISOString(); }));
  await assert.rejects(as(() => scheduler.scheduleApplication({ ...fields(done), sendAt: inMinutes(10) })), { code: "DUPLICATE" });
  const ok = await as(() => scheduler.scheduleApplication({ ...fields(done), sendAt: inMinutes(10), allowDuplicate: true }));
  assert.equal(ok.application.schedule.allowDuplicate, true);
});

test("bad recipient is caught when scheduling, not later", async () => {
  const app = await newApplication();
  await assert.rejects(as(() => scheduler.scheduleApplication({ ...fields(app), to: "not-an-email", sendAt: inMinutes(10) })), { code: "BAD_RECIPIENT" });
});

test("Gmail sign-in older than ~7 days by the send time → warning", async () => {
  const app = await newApplication();
  await as(() => updateJson("gmail-tokens", null, (t) => ({ value: { ...t, connectedAt: new Date(Date.now() - 5 * 864e5).toISOString() } })));
  const { warning } = await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: new Date(Date.now() + 3 * 864e5).toISOString() }));
  assert.match(warning, /Reconnect Gmail/);
  const app2 = await newApplication();
  const fresh = await as(() => scheduler.scheduleApplication({ ...fields(app2), sendAt: inMinutes(30) }));
  assert.equal(fresh.warning, null);
});

test("a send interrupted mid-way is never re-sent automatically", async () => {
  const app = await newApplication();
  await as(() => scheduler.scheduleApplication({ ...fields(app), sendAt: inMinutes(10) }));
  // A server claimed it 10 minutes ago and died.
  await updateJson("jobs", { jobs: [] }, (db) => {
    for (const j of db.jobs) if (j.application_id === app.id) Object.assign(j, { status: "sending", claimed_at: new Date(Date.now() - 600e3).toISOString() });
    return { value: db, result: null };
  }, { user: "_schedule" });
  await scheduler.runDueJobs();   // marks it failed
  await scheduler.runDueJobs();   // copies the failure onto the application
  assert.equal(sent.length, 0);
  const after = await as(() => getApplication(app.id));
  assert.equal(after.schedule.status, "failed");
  assert.match(after.schedule.error, /Sent folder/);
});
