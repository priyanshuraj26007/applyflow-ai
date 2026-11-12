// Tests the model fallback + "racing" logic in lib/gemini.js with a FAKE Gemini
// (no network, no quota used). Run with: npm.cmd test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_HEDGE_MS = "40";               // race after 40ms instead of 5s
process.env.GEMINI_MODELS_DRAFT = "m1,m2,m3";
process.env.GEMINI_MODELS_SMART = "s1,s2";

const { callGemini, _setClientForTests } = await import("../lib/gemini.js");

// Fake client: each model has a behaviour { delay, fail?: status }.
let behaviour = {};
let calls = [];
let aborted = [];
function fakeClient() {
  return {
    models: {
      generateContent({ model, config }) {
        calls.push(model);
        const b = behaviour[model] || { delay: 5 };
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

test("every model fails → clear error from the last failure", async () => {
  behaviour = { m1: { delay: 5, fail: 503 }, m2: { delay: 5, fail: 429 }, m3: { delay: 5, fail: 503 } };
  await assert.rejects(callGemini("draft", "hi"), (err) => err.code === "GEMINI_OVERLOADED");
  assert.deepEqual(calls, ["m1", "m2", "m3"]);
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
