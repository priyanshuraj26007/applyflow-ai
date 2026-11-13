// Tests Groq-first / Gemini-backup routing with FAKE providers (no network, no quota).
// Run with: npm.cmd test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.AI_PROVIDERS = "groq,gemini";
process.env.GROQ_API_KEY = "test-key";
process.env.GEMINI_API_KEY = "test-key";
process.env.APPLYFLOW_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "applyflow-ai-test-"));
process.env.GROQ_MODELS_DRAFT = "g1,g2";
process.env.GEMINI_MODELS_DRAFT = "m1";
process.env.AI_HEDGE_MS = "40";
process.env.AI_RETRY_DELAY_MS = "30";

const { _setClientForTests } = await import("../lib/gemini.js");
const { _setGroqFetchForTests, toJsonSchema } = await import("../lib/groq.js");
const { callAI, callAIJson, MODEL_TIERS } = await import("../lib/ai-router.js");

// behaviour[model] = { delay, status? } ; status ≠ 200 → error response
let behaviour = {};
let groqCalls = [];
let geminiCalls = [];
let lastGroqBody = null;

function fakeFetch(url, { body, signal }) {
  const req = JSON.parse(body);
  groqCalls.push(req.model);
  lastGroqBody = req;
  const b = behaviour[req.model] || { delay: 5 };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const status = b.status || 200;
      resolve({
        ok: status === 200,
        status,
        json: async () => status === 200
          ? { choices: [{ message: { content: b.content || `{"answer":"from ${req.model}"}` } }] }
          : { error: { message: `fake ${status}`, ...(b.failedGeneration != null ? { code: "json_validate_failed", failed_generation: b.failedGeneration } : {}) } }
      });
    }, b.delay);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
}

const fakeGemini = {
  models: {
    generateContent({ model, config }) {
      geminiCalls.push(model);
      const b = behaviour[model] || { delay: 5 };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => b.status
          ? reject(Object.assign(new Error(`fake ${b.status}`), { status: b.status }))
          : resolve({ text: `{"answer":"from ${model}"}` }), b.delay);
        config.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
      });
    }
  }
};

beforeEach(() => {
  behaviour = {};
  groqCalls = [];
  geminiCalls = [];
  lastGroqBody = null;
  _setGroqFetchForTests(fakeFetch);
  _setClientForTests(fakeGemini);
});

test("Groq is tried first, Gemini is the backup (order from AI_PROVIDERS)", () => {
  assert.deepEqual(MODEL_TIERS.draft, ["groq g1", "groq g2", "m1"]);
});

test("healthy Groq → answers alone, with strict JSON schema", async () => {
  const schema = { type: "OBJECT", properties: { answer: { type: "STRING" } }, required: ["answer"] };
  const result = await callAIJson("draft", "hi", schema);
  assert.equal(result.provider, "groq");
  assert.equal(result.data.answer, "from g1");
  assert.deepEqual(groqCalls, ["g1"]);
  assert.deepEqual(geminiCalls, []);
  assert.equal(lastGroqBody.response_format.type, "json_schema");
  assert.equal(lastGroqBody.response_format.json_schema.strict, true);
});

test("Groq rate-limited (429) → next Groq model answers", async () => {
  behaviour = { g1: { delay: 5, status: 429 } };
  const result = await callAI("draft", "hi");
  assert.equal(result.model, "g2");
  assert.deepEqual(groqCalls, ["g1", "g2"]);
});

test("all Groq models down → Gemini answers", async () => {
  behaviour = { g1: { delay: 5, status: 429 }, g2: { delay: 5, status: 503 } };
  const result = await callAI("draft", "hi");
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "m1");
});

test("bad Groq key → remaining Groq models skipped, Gemini still used", async () => {
  behaviour = { g1: { delay: 5, status: 401 } };
  const result = await callAI("draft", "hi");
  assert.equal(result.provider, "gemini");
  assert.deepEqual(groqCalls, ["g1"]);
});

test("everything busy → one retry round, then a friendly 'try again' error", async () => {
  behaviour = { g1: { delay: 5, status: 429 }, g2: { delay: 5, status: 429 }, m1: { delay: 5, status: 503 } };
  await assert.rejects(callAI("draft", "hi"), (err) =>
    err.code === "GEMINI_OVERLOADED" && /all providers tried/.test(err.message));
  assert.deepEqual(groqCalls, ["g1", "g2", "g1", "g2"]);
  assert.deepEqual(geminiCalls, ["m1", "m1"]);
});

test("Groq broken JSON (400) → next model, not a retry storm", async () => {
  behaviour = { g1: { delay: 5, status: 400 } };
  const result = await callAI("draft", "hi");
  assert.equal(result.model, "g2");
});

test("Groq format slip (json_validate_failed) → the model's own JSON is repaired and used", async () => {
  behaviour = { g1: { delay: 5, status: 400, failedGeneration: '{"answer":"salvaged","score":"thirty"}' } };
  const result = await callAIJson("draft", "hi", { type: "OBJECT", properties: { answer: { type: "STRING" } } });
  assert.equal(result.model, "g1");
  assert.equal(result.data.answer, "salvaged");
  assert.deepEqual(groqCalls, ["g1"]);
});

test("Groq format slip with unusable output → next model", async () => {
  behaviour = { g1: { delay: 5, status: 400, failedGeneration: "not json {" } };
  const result = await callAI("draft", "hi");
  assert.equal(result.model, "g2");
});

test("schema conversion: Gemini style → strict JSON Schema", () => {
  const out = toJsonSchema({
    type: "OBJECT",
    properties: { name: { type: "STRING", nullable: true }, tags: { type: "ARRAY", items: { type: "STRING" } } },
    propertyOrdering: ["name", "tags"]
  });
  assert.deepEqual(out, {
    type: "object",
    properties: { name: { type: ["string", "null"] }, tags: { type: "array", items: { type: "string" } } },
    required: ["name", "tags"],
    additionalProperties: false
  });
});
