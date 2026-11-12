// ==========================================
// GROQ PROVIDER (fast open models on Groq's chips)
// ==========================================
// Groq speaks the OpenAI chat API. We ask for low "reasoning effort" (≈2x faster
// with no loss in email quality in our tests) and STRICT JSON: Groq enforces the
// same schema the Gemini prompts use, so answers always parse.
// Override in .env, e.g. GROQ_MODELS_DRAFT=openai/gpt-oss-120b,openai/gpt-oss-20b
import { GeminiError, parseModels } from "./gemini.js";

const DEFAULT_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b";
export const GROQ_TIERS = {
  // Reading a post is simple extraction (strict JSON) — the small model does it well and
  // keeps the big model's per-minute token budget free for writing the email.
  fast: parseModels(process.env.GROQ_MODELS_FAST, "openai/gpt-oss-20b,openai/gpt-oss-120b"),
  smart: parseModels(process.env.GROQ_MODELS_SMART, DEFAULT_MODELS),
  draft: parseModels(process.env.GROQ_MODELS_DRAFT, DEFAULT_MODELS),
  // Resume scoring is simple and runs at the same time as the email: use the small
  // model first so the big model's per-minute token budget goes to the email.
  match: parseModels(process.env.GROQ_MODELS_MATCH, "openai/gpt-oss-20b,openai/gpt-oss-120b")
};

// Resume analysis happens once in the background, so it can think a bit harder.
const EFFORT = {
  fast: process.env.GROQ_REASONING_EFFORT || "low",
  draft: process.env.GROQ_REASONING_EFFORT || "low",
  match: process.env.GROQ_REASONING_EFFORT || "low",
  smart: process.env.GROQ_REASONING_EFFORT_SMART || "medium"
};
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 15000;
// Answer-length cap (includes the model's reasoning). Tells Groq exactly how much to reserve
// from the per-minute token budget; a cut-off answer is rejected rather than used.
const MAX_TOKENS = { fast: 2000, match: 2000, draft: 2000, smart: 4000 };
export const groqTimeout = (tier) => (tier === "smart" ? GROQ_TIMEOUT_MS * 2 : GROQ_TIMEOUT_MS);

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
let fetchImpl = (...args) => fetch(...args);

/** Convert a Gemini-style schema (OBJECT/STRING, nullable, propertyOrdering) to strict JSON Schema. */
export function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  const type = String(s.type || "STRING").toLowerCase();
  const out = {};
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (type === "object") {
    out.type = "object";
    out.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = Object.keys(out.properties);   // strict mode: every key present (may be null)
    out.additionalProperties = false;
  } else if (type === "array") {
    out.type = "array";
    out.items = toJsonSchema(s.items || { type: "STRING" });
  } else {
    out.type = type;
  }
  if (s.nullable) out.type = [out.type, "null"];
  return out;
}

export function classifyGroqError(status, message = "") {
  if (status === 401 || status === 403) return new GeminiError("GEMINI_AUTH", "Groq API key was rejected.", status);
  if (status === 404) return new GeminiError("GEMINI_MODEL_UNAVAILABLE", "Groq model is not available for this key.", status);
  if (status === 429) {
    const daily = /per day|TPD|RPD/i.test(message);
    const err = new GeminiError("GEMINI_RATE_LIMIT", daily
      ? "Groq's free daily limit for this model is used up (it refills gradually over 24 hours)."
      : "Groq rate limit reached. Try again in a minute.", status);
    err.detail = daily ? "daily limit used up - refills over 24h" : "per-minute limit";
    return err;
  }
  if (status === 400 || status === 413 || status === 422) {
    return new GeminiError("GEMINI_BAD_OUTPUT", "Groq could not produce a valid answer.", status);
  }
  if (status === 504 || /timeout|timed out|abort/i.test(message)) {
    return new GeminiError("GEMINI_TIMEOUT", "Groq took too long to respond.", 504);
  }
  if (status >= 500) return new GeminiError("GEMINI_OVERLOADED", "Groq is overloaded right now.", status);
  return new GeminiError("GEMINI_ERROR", "Groq request failed.", status || 500);
}

/** One request to one Groq model. Returns the response text (JSON when a schema is given). */
export async function groqGenerate({ model, contents, config = {}, signal, timeout, tier }) {
  if (!process.env.GROQ_API_KEY) {
    throw new GeminiError("GEMINI_AUTH", "GROQ_API_KEY is missing in backend/.env.", 401);
  }
  const schema = config.responseSchema;
  const body = {
    model,
    messages: [{ role: "user", content: schema
      ? `${contents}\n\nReply with the JSON object only. Write every number as digits (e.g. 72), never as words.`
      : contents }],
    temperature: 0.6,
    max_completion_tokens: MAX_TOKENS[tier] || 2000,
    ...(/gpt-oss/.test(model) ? { reasoning_effort: EFFORT[tier] || "low" } : {}),
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "result", schema: toJsonSchema(schema), strict: true } } } : {})
  };

  const timeoutSignal = AbortSignal.timeout(timeout || GROQ_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
  } catch (error) {
    if (timeoutSignal.aborted) throw classifyGroqError(504, "timeout");
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    throw classifyGroqError(503, String(error?.message)); // network blip → treat as temporary
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // Strict-schema check failed (e.g. a score written as "thirty"). Groq still
    // returns what the model wrote — if it's valid JSON, use it: our own
    // normalisers in ai.js validate and repair every field anyway.
    const salvaged = salvageFailedGeneration(data);
    if (salvaged) {
      console.log(`ApplyFlow AI: groq ${model} answer had a format slip - repaired it`);
      return salvaged;
    }
    throw classifyGroqError(response.status, data?.error?.message);
  }
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (choice?.finish_reason === "length") throw classifyGroqError(422, "cut off");
  if (typeof text !== "string" || !text.trim()) throw classifyGroqError(422, "empty");
  return text;
}

/** Return the model's own JSON from a json_validate_failed error, or null. */
export function salvageFailedGeneration(data) {
  if (data?.error?.code !== "json_validate_failed") return null;
  const text = data.error.failed_generation;
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? text : null;
  } catch {
    return null;
  }
}

// Tests can swap in a fake fetch.
export function _setGroqFetchForTests(fake) {
  fetchImpl = fake;
}
