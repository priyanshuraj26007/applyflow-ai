// Tests the model fallback + "racing" logic in lib/gemini.js with a FAKE Gemini
// (no network, no quota used). Run with: npm.cmd test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_HEDGE_MS = "40";               // race after 40ms instead of 5s
process.env.GEMINI_MODELS_DRAFT = "m1,m2,m3";
process.env.GEMINI_MODELS_SMART = "s1,s2";
process.env.GEMINI_RETRY_DELAY_MS = "30";         // retry round after 30ms instead of 2s

process.env.AI_PROVIDERS = "gemini";               // these tests cover the racing engine with one provider
process.env.GEMINI_API_KEY = "test-key";
process.env.APPLYFLOW_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "applyflow-ai-test-"));

const { _setClientForTests } = await import("../lib/gemini.js");
const { callAI: callGemini } = await import("../lib/ai-router.js");

// Fake client: each model has a behaviour { delay, fail?: status }.
let behaviour = {};
let calls = [];
let aborted = [];
function fakeClient() {
  return {
    models: {
      generateContent({ model, config }) {
        calls.push(model);
        const spec = behaviour[model] || { delay: 5 };
        const n = calls.filter(m => m === model).length - 1;
        const b = Array.isArray(spec) ? spec[Math.min(n, spec.length - 1)] : spec;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (b.fail) reject(Object.assign(new Error(`fake ${b.fail}`), { status: b.fail }));
            else resolve({ text: `answer from ${model}` });
          }, b.delay);
          config.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted.push(model);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
    }
  };
}

beforeEach(() => {
  calls = [];
  aborted = [];
  _setClientForTests(fakeClient());
});

test("slow first model → backup is raced and wins; the slow one is cancelled", async () => {
  behaviour = { m1: { delay: 1000 }, m2: { delay: 20 } };
  const started = Date.now();
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m2");
  assert.ok(Date.now() - started < 400, "should not wait for the slow model");
  assert.deepEqual(aborted, ["m1"]);
});

test("healthy first model → no extra request", async () => {
  behaviour = { m1: { delay: 10 } };
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m1");
  assert.deepEqual(calls, ["m1"]);
});

test("failed model → next one starts immediately", async () => {
  behaviour = { m1: { delay: 5, fail: 503 }, m2: { delay: 5 } };
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m2");
  assert.deepEqual(calls, ["m1", "m2"]);
});

test("every model keeps failing → one retry round, then a clear error", async () => {
  behaviour = { m1: { delay: 5, fail: 503 }, m2: { delay: 5, fail: 429 }, m3: { delay: 5, fail: 503 } };
  await assert.rejects(callGemini("draft", "hi"), (err) => err.code === "GEMINI_OVERLOADED");
  assert.deepEqual(calls, ["m1", "m2", "m3", "m1", "m2", "m3"]);
});

test("all models busy, then Google recovers → the retry round succeeds", async () => {
  behaviour = {
    m1: [{ delay: 5, fail: 503 }, { delay: 5 }],
    m2: { delay: 5, fail: 503 },
    m3: { delay: 5, fail: 504 }
  };
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m1");
  assert.deepEqual(calls, ["m1", "m2", "m3", "m1"]);
});

test("a failed model is replaced at once, even while another is still running", async () => {
  // m1 hangs → m2 is raced at 40ms → m2 fails at ~45ms → m3 must start then,
  // not wait for m1.
  behaviour = { m1: { delay: 2000 }, m2: { delay: 5, fail: 503 }, m3: { delay: 10 } };
  const started = Date.now();
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m3");
  assert.ok(Date.now() - started < 400, "should not wait for the hung model");
  assert.deepEqual(aborted, ["m1"]);
});

test("retired model (404) is skipped in the retry round", async () => {
  behaviour = { m1: { delay: 5, fail: 404 }, m2: [{ delay: 5, fail: 503 }, { delay: 5 }], m3: { delay: 5, fail: 503 } };
  const result = await callGemini("draft", "hi");
  assert.equal(result.model, "m2");
  assert.deepEqual(calls, ["m1", "m2", "m3", "m2"]);
});

test("bad API key after a busy model → no retry round", async () => {
  behaviour = { m1: { delay: 5, fail: 503 }, m2: { delay: 5, fail: 403 } };
  await assert.rejects(callGemini("draft", "hi"), (err) => err.code === "GEMINI_AUTH");
  assert.deepEqual(calls, ["m1", "m2"]);
});

test("bad API key → stops at once (switching models can't fix it)", async () => {
  behaviour = { m1: { delay: 5, fail: 403 } };
  await assert.rejects(callGemini("draft", "hi"), (err) => err.code === "GEMINI_AUTH");
  assert.deepEqual(calls, ["m1"]);
});

test("smart tier (background resume analysis) is never raced", async () => {
  behaviour = { s1: { delay: 120 } };
  const result = await callGemini("smart", "hi");
  assert.equal(result.model, "s1");
  assert.deepEqual(calls, ["s1"]);
});
