// Hosted mode: one backend, many testers — each tester's data must stay separate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.APPLYFLOW_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "applyflow-hosted-test-"));
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const { runAsUser, USER_ID_RE } = await import("../lib/context.js");
const { readJson, updateJson, writeFile, readFile } = await import("../lib/store.js");
const { saveSettings, getSettings, publicSettings } = await import("../lib/settings.js");
const { callAI, aiKeys } = await import("../lib/ai-router.js");

const ALICE = "a".repeat(43);
const BOB = "b".repeat(43);
const GROQ_KEY = "gsk_" + "x".repeat(48) + "WXYZ";

test("tester IDs: long random IDs pass, short or odd ones are rejected", () => {
  assert.ok(USER_ID_RE.test(ALICE));
  assert.ok(!USER_ID_RE.test("short"));
  assert.ok(!USER_ID_RE.test("../".repeat(15)));
});

test("each tester only sees their own documents and files", async () => {
  await runAsUser(ALICE, () => updateJson("settings", {}, () => ({ value: { senderName: "Alice" }, result: null })));
  await runAsUser(ALICE, () => writeFile("r1.pdf", Buffer.from("%PDF-alice")));

  assert.equal((await runAsUser(ALICE, () => readJson("settings", {}))).senderName, "Alice");
  assert.deepEqual(await runAsUser(BOB, () => readJson("settings", {})), {});
  assert.equal(await runAsUser(BOB, () => readFile("r1.pdf")), null);
  assert.equal(String(await runAsUser(ALICE, () => readFile("r1.pdf"))), "%PDF-alice");
});

test("storage names can't escape the tester's folder", async () => {
  await assert.rejects(runAsUser(ALICE, () => readJson("../other", {})));
  await assert.rejects(runAsUser(ALICE, () => readFile("../../x.pdf")));
});

test("AI keys: saved per tester, masked for the browser, bad keys rejected", async () => {
  await runAsUser(ALICE, () => saveSettings({ groqApiKey: ` ${GROQ_KEY} ` }));
  const alice = await runAsUser(ALICE, () => getSettings());
  assert.equal(alice.groqApiKey, GROQ_KEY, "trimmed + stored");

  const shown = publicSettings(alice);
  assert.equal(shown.groqApiKey, undefined, "full key never sent to the browser");
  assert.equal(shown.keys.groq, "gsk_…WXYZ");
  assert.equal(shown.keys.gemini, null);

  // Saving other settings without the key keeps it.
  await runAsUser(ALICE, () => saveSettings({ phone: "123" }));
  assert.equal((await runAsUser(ALICE, () => getSettings())).groqApiKey, GROQ_KEY);

  await assert.rejects(runAsUser(ALICE, () => saveSettings({ groqApiKey: "sk-openai-key" })), { code: "BAD_API_KEY" });

  // Bob has no key, and can't use Alice's.
  assert.equal((await runAsUser(BOB, () => aiKeys())).groq, "");

  // Empty string removes the key.
  await runAsUser(ALICE, () => saveSettings({ groqApiKey: "" }));
  assert.equal((await runAsUser(ALICE, () => getSettings())).groqApiKey, "");
});

test("no AI key → clear message telling the tester where to add one", async () => {
  await assert.rejects(runAsUser(BOB, () => callAI("fast", "hi")), (error) => {
    assert.equal(error.code, "NO_AI_KEY");
    assert.equal(error.status, 400);
    assert.match(error.message, /Settings/);
    return true;
  });
});

test("any real-looking key format is accepted; junk is rejected", async () => {
  // Google issues more than one Gemini key format — none should be refused for its prefix.
  for (const key of ["AIzaSyD" + "x".repeat(32), "AQ.Ab8RN6" + "y".repeat(40), "gsk_" + "z".repeat(52)]) {
    await runAsUser(ALICE, () => saveSettings({ geminiApiKey: key }));
    assert.equal((await runAsUser(ALICE, () => getSettings())).geminiApiKey, key);
  }
  await assert.rejects(runAsUser(ALICE, () => saveSettings({ geminiApiKey: "has a space in it 1234567890" })), { code: "BAD_API_KEY" });
  await assert.rejects(runAsUser(ALICE, () => saveSettings({ geminiApiKey: "short" })), { code: "BAD_API_KEY" });
  await runAsUser(ALICE, () => saveSettings({ geminiApiKey: "" }));
});

test("testing one provider: a missing key for that provider is reported clearly", async () => {
  await assert.rejects(runAsUser(BOB, () => callAI("fast", "hi", {}, { only: "gemini" })), (error) => {
    assert.equal(error.code, "NO_AI_KEY");
    assert.match(error.message, /Gemini/);
    return true;
  });
});

test("per-request cache: reads are cached, writes update the cache, callers can't corrupt it", async () => {
  await runAsUser(ALICE, async () => {
    await updateJson("doc", {}, () => ({ value: { n: 1 } }));
    const first = await readJson("doc", {});
    first.n = 999;                                   // caller mutates its copy
    assert.equal((await readJson("doc", {})).n, 1, "cache not corrupted");
    await updateJson("doc", {}, (v) => ({ value: { n: v.n + 1 } }));
    assert.equal((await readJson("doc", {})).n, 2, "write visible in the same request");
  });
  assert.equal(Object.keys(await runAsUser(BOB, () => readJson("doc", {}))).length, 0, "other tester unaffected");
});

test("Settings autofill: name, phone and LinkedIn come from the resume", async () => {
  const { publicResume, linkedinFromText } = await import("../lib/resumes.js");
  assert.equal(linkedinFromText("Find me: in.linkedin.com/in/priyanshu-raj/ thanks"), "https://www.linkedin.com/in/priyanshu-raj");
  assert.equal(linkedinFromText("no profile link here"), null);
  const shown = publicResume({ id: "x", text: "linkedin.com/in/abc-123", profile: { name: "Priyanshu", phone: "+91 98" } });
  assert.deepEqual(shown.contact, { name: "Priyanshu", phone: "+91 98", linkedin: "https://www.linkedin.com/in/abc-123" });
  assert.equal(shown.text, undefined, "full resume text is still never sent");
});
