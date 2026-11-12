// Run with: npm.cmd test
// Uses Node's built-in test runner — no extra packages needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Use a throw-away data folder so tests never touch your real resumes/applications.
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "applyflow-test-"));
process.env.APPLYFLOW_DATA_DIR = tmpDir;

const { buildMimeMessage, EMAIL_RE, textToHtml } = await import("../lib/gmail.js");
const { signatureBlock } = await import("../lib/ai.js");
const { normaliseJob, normaliseRankings, toScore } = await import("../lib/ai.js");
const { hashPost, roleKey, upsertFromPost, editApplication, findDuplicates } = await import("../lib/applications.js");
const { readJson, updateJson } = await import("../lib/store.js");
const { assertPdf } = await import("../lib/resumes.js");

test.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

// ---------- Email (MIME) builder ----------
test("MIME message has recipient, encoded subject, body and PDF attachment", () => {
  const mime = buildMimeMessage({
    to: "hr@example.com",
    subject: "Application for Product Manager – Riya",
    body: "Hi team,\nPlease find my resume attached.",
    attachment: { filename: "resume.pdf", content: Buffer.from("%PDF-1.4 test") }
  });
  assert.match(mime, /^To: hr@example\.com\r\n/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/); // non-ASCII dash → encoded
  assert.match(mime, /Content-Type: application\/pdf; name="resume\.pdf"/);
  assert.ok(mime.includes(Buffer.from("%PDF-1.4 test").toString("base64")));
});

test("MIME message has both plain-text and HTML versions", () => {
  const mime = buildMimeMessage({ to: "hr@example.com", subject: "Hi", body: "Dear Team,\n\nHello." });
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="applyflow_alt_/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
});

test("textToHtml makes paragraphs, line breaks and links — and escapes HTML", () => {
  const html = textToHtml(
    "Dear Team,\n\nI build <script>alert(1)</script> things & more.\n\nWarm regards,\nJARVIS | 93191\nhttps://www.linkedin.com/in/test/"
  );
  assert.equal((html.match(/<p /g) || []).length, 3);
  assert.ok(html.includes("Warm regards,<br>JARVIS | 93191<br>"));
  assert.ok(html.includes('<a href="https://www.linkedin.com/in/test/"'));
  assert.ok(!html.includes("<script>"), "user text must be escaped");
  assert.ok(html.includes("&lt;script&gt;") && html.includes("&amp; more"));
});

test("signatureBlock: default sign-off, or the user's own signature", () => {
  assert.equal(
    signatureBlock({ phone: "93191", linkedinUrl: "https://linkedin.com/in/x" }, "JARVIS"),
    "Warm regards,\nJARVIS | 93191\nhttps://linkedin.com/in/x"
  );
  assert.equal(signatureBlock({ signature: "  Best,\nP  " }, "JARVIS"), "Best,\nP");
});

test("MIME builder blocks header injection via newlines", () => {
  const mime = buildMimeMessage({
    to: "hr@example.com",
    subject: "Hello\r\nBcc: victim@example.com",
    body: "x"
  });
  assert.ok(!/\r\nBcc:/.test(mime), "newline in subject must not create a new header");
});

test("MIME builder rejects invalid recipients and empty content", () => {
  assert.throws(() => buildMimeMessage({ to: "not-an-email", subject: "s", body: "b" }), /not valid/);
  assert.throws(() => buildMimeMessage({ to: "a@b.com\nBcc: x@y.com", subject: "s", body: "b" }), /not valid/);
  assert.throws(() => buildMimeMessage({ to: "a@b.com", subject: " ", body: "b" }), /subject/);
  assert.throws(() => buildMimeMessage({ to: "a@b.com", subject: "s", body: "" }), /body/);
  assert.ok(EMAIL_RE.test("first.last+jobs@company.co.in"));
});

// ---------- Gemini output validation ----------
test("normaliseJob cleans Gemini output and never trusts bad values", () => {
  const job = normaliseJob({
    isHiringPost: "yes",          // not a real boolean → false
    jobTitle: "  Product Manager ",
    email: "not an email",
    category: "Astronaut",        // unknown → Other
    skills: ["SQL", "", 42, " Jira "]
  });
  assert.equal(job.isHiringPost, false);
  assert.equal(job.jobTitle, "Product Manager");
  assert.equal(job.email, null);
  assert.equal(job.category, "Other");
  assert.deepEqual(job.skills, ["SQL", "Jira"]);
  assert.equal(job.company, null);
  assert.throws(() => normaliseJob("not an object"));
});

test("normaliseRankings drops unknown/duplicate resumes, clamps scores, best first", () => {
  const usable = [{ id: "a" }, { id: "b" }];
  const { rankings, recommendedResumeId } = normaliseRankings({
    rankings: [
      { resumeId: "a", score: 140, reasons: ["x"], missingSkills: [], relevantHighlights: [] },
      { resumeId: "ghost", score: 99, reasons: [], missingSkills: [], relevantHighlights: [] },
      { resumeId: "b", score: -5, reasons: [], missingSkills: [], relevantHighlights: [] },
      { resumeId: "a", score: 10, reasons: [], missingSkills: [], relevantHighlights: [] }
    ]
  }, usable);
  assert.deepEqual(rankings.map(r => [r.resumeId, r.score]), [["a", 100], ["b", 0]]);
  assert.equal(recommendedResumeId, "a");
  assert.throws(() => normaliseRankings({ rankings: [{ resumeId: "ghost", score: 50 }] }, usable), /rankings/);
});

// ---------- Duplicate detection ----------
test("hashPost ignores timestamps and tracking links", () => {
  const a = "We're hiring a PM! Send CV to hr@x.com 3d https://lnkd.in/abc";
  const b = "We're hiring a PM! Send CV to hr@x.com 1w https://lnkd.in/xyz";
  assert.equal(hashPost(a), hashPost(b));
  assert.notEqual(hashPost(a), hashPost("We're hiring a designer! Send CV to hr@x.com"));
});

test("same post twice → one record; same role re-posted → flagged as duplicate", async () => {
  const job = { isHiringPost: true, jobTitle: "Data Analyst", email: "jobs@acme.com" };
  const first = await upsertFromPost({ postText: "Acme is hiring a Data Analyst. Send CV to jobs@acme.com", job, analysisSource: "gemini" });
  const again = await upsertFromPost({ postText: "Acme is hiring a Data Analyst. Send CV to jobs@acme.com", job, analysisSource: "gemini" });
  assert.equal(first.id, again.id);

  await editApplication(first.id, { status: "Applied" });
  const repost = await upsertFromPost({ postText: "Reposting: Data Analyst role at Acme, CV to jobs@acme.com", job, analysisSource: "gemini" });
  const dups = await findDuplicates(repost);
  assert.equal(dups.length, 1);
  assert.ok(dups[0].appliedAt);
  assert.equal(roleKey({ email: "A@x.com", jobTitle: "Data  Analyst!" }), "a@x.com|data analyst");
});

test("local fallback data never overwrites Gemini data", async () => {
  const text = "Hiring Product Manager at Beta Corp, resumes to pm@beta.com please";
  await upsertFromPost({ postText: text, job: { jobTitle: "Product Manager (AI)" }, analysisSource: "gemini" });
  const after = await upsertFromPost({ postText: text, job: { jobTitle: "Hiring opportunity" }, analysisSource: "local" });
  assert.equal(after.job.jobTitle, "Product Manager (AI)");
});

test("editApplication rejects unknown statuses", async () => {
  const app = await upsertFromPost({ postText: "Gamma is hiring an Ops lead, write to ops@gamma.com", job: { jobTitle: "Ops" } });
  await assert.rejects(editApplication(app.id, { status: "Hacked" }), /Unknown status/);
});

// ---------- Storage ----------
test("store serialises concurrent writes (no lost updates)", async () => {
  await Promise.all(Array.from({ length: 25 }, () =>
    updateJson("counter", { n: 0 }, (v) => ({ value: { n: v.n + 1 }, result: null }))
  ));
  assert.equal((await readJson("counter", { n: 0 })).n, 25);
});

// ---------- Upload validation ----------
test("assertPdf accepts real PDFs and rejects fakes / oversized files", () => {
  assert.doesNotThrow(() => assertPdf(Buffer.from("%PDF-1.7\n...")));
  assert.throws(() => assertPdf(Buffer.from("MZ executable pretending")), /not a valid PDF/);
  assert.throws(() => assertPdf(Buffer.alloc(0)), /empty/);
  assert.throws(() => assertPdf(Buffer.alloc(6 * 1024 * 1024, 0x25)), /5 MB/);
});

test("toScore understands digits, percentages and numbers written as words", () => {
  assert.equal(toScore(72), 72);
  assert.equal(toScore("85"), 85);
  assert.equal(toScore("64%"), 64);
  assert.equal(toScore("thirty"), 30);
  assert.equal(toScore("seventy-two"), 72);
  assert.equal(toScore("Eighty five"), 85);
  assert.equal(toScore("nine"), 9);
  assert.equal(toScore("one hundred"), 100);
  assert.equal(toScore(140), 100);
  assert.equal(toScore("n/a"), 0);
  assert.equal(toScore(null), 0);
});
