// ==========================================
// GEMINI MODEL TIERS + RESILIENT CALLS
// ==========================================
// Each tier is an ordered list of models. If a model is overloaded (503),
// times out (504), is rate-limited (429) or retired (404), we try the next one.
// Override in .env, e.g. GEMINI_MODELS_FAST=gemini-3.5-flash-lite,gemini-3.5-flash
import { GoogleGenAI } from "@google/genai";

const parseModels = (value, fallback) =>
  (value || fallback).split(",").map(m => m.trim()).filter(Boolean);

export const MODEL_TIERS = {
  // Tier 1: cheap + fast — job post extraction / classification
  fast: parseModels(
    process.env.GEMINI_MODELS_FAST,
    "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash"
  ),
  // Tier 2: stronger — one-time resume analysis (quality matters, speed doesn't)
  smart: parseModels(
    process.env.GEMINI_MODELS_SMART,
    "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
  ),
  // Draft tier: matching + email while the user waits — fastest model first
  draft: parseModels(
    process.env.GEMINI_MODELS_DRAFT,
    "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash"
  )
};

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;
// The user is waiting on drafts, and healthy lite models answer in ~4s —
// so give up on a stuck model quickly and move to the next one.
const TIER_TIMEOUT_MS = { draft: Number(process.env.GEMINI_DRAFT_TIMEOUT_MS) || 12000 };

// "Racing": for tiers the user waits on, if a model hasn't answered after this
// long, ALSO ask the next model and use whichever answers first. Healthy models
// answer in ~2-4s, so this only costs an extra request when something is stuck.
const HEDGE_MS = Number(process.env.GEMINI_HEDGE_MS) || 5000;
const HEDGED_TIERS = new Set(["fast", "draft"]);

// Errors worth retrying on another model (temporary problems on Google's side).
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);

export class GeminiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let ai = null;
function client() {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new GeminiError("GEMINI_AUTH", "GEMINI_API_KEY is missing in backend/.env.", 500);
    }
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

// Turn a raw SDK error into a short, safe code + message (never includes the key).
export function classifyGeminiError(error) {
  if (error instanceof GeminiError) return error;
  const status = error?.status;
  const msg = String(error?.message || "");

  if (status === 400 && /api key/i.test(msg)) return new GeminiError("GEMINI_AUTH", "Gemini API key is invalid.", status);
  if (status === 401 || status === 403) return new GeminiError("GEMINI_AUTH", "Gemini API key was rejected.", status);
  if (status === 404) return new GeminiError("GEMINI_MODEL_UNAVAILABLE", "Gemini model is not available for this key.", status);
  if (status === 429) return new GeminiError("GEMINI_RATE_LIMIT", "Gemini rate limit or quota reached. Try again in a minute.", status);
  if (status === 503) return new GeminiError("GEMINI_OVERLOADED", "Gemini is overloaded right now.", status);
  if (status === 504 || /timeout|timed out|abort|deadline/i.test(msg)) {
    return new GeminiError("GEMINI_TIMEOUT", "Gemini took too long to respond.", 504);
  }
  return new GeminiError("GEMINI_ERROR", "Gemini request failed.", status || 500);
}

// Tests can swap in a fake Gemini client.
export function _setClientForTests(fake) {
  ai = fake;
}

/**
 * Call Gemini, falling back through the tier's models until one succeeds.
 *  - A model that FAILS (503, 429, timeout…) → the next model starts right away.
 *  - A model that is SLOW (no answer after HEDGE_MS, "fast"/"draft" tiers only)
 *    → the next model starts in parallel; the first good answer wins and the
 *    other request is cancelled.
 * Returns { text, model, durationMs }.
 */
export function callGemini(tier, contents, config = {}) {
  const models = MODEL_TIERS[tier] || [];
  const timeout = TIER_TIMEOUT_MS[tier] || GEMINI_TIMEOUT_MS;
  const hedge = HEDGED_TIERS.has(tier);
  const callStart = Date.now();

  return new Promise((resolve, reject) => {
    let nextIndex = 0;
    let running = 0;
    let settled = false;
    let lastError = null;
    const controllers = new Set();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      controllers.forEach(c => c.abort()); // cancel any slower request still running
      fn(value);
    };

    const failIfNothingLeft = () => {
      if (running === 0 && nextIndex >= models.length) {
        finish(reject, lastError || new GeminiError("GEMINI_ERROR", "No Gemini models configured.", 500));
      }
    };

    const launch = () => {
      if (settled || nextIndex >= models.length) return;
      const model = models[nextIndex++];
      const controller = new AbortController();
      controllers.add(controller);
      running++;
      const start = Date.now();

      const hedgeTimer = hedge && nextIndex < models.length
        ? setTimeout(() => {
            if (settled) return;
            console.log(`ApplyFlow AI: ${model} is slow (${(HEDGE_MS / 1000).toFixed(0)}s) - also asking ${models[nextIndex]}`);
            launch();
          }, HEDGE_MS)
        : null;

      Promise.resolve()
        .then(() => client().models.generateContent({
          model,
          contents,
          config: { ...config, abortSignal: controller.signal, httpOptions: { timeout } }
        }))
        .then((response) => {
          clearTimeout(hedgeTimer);
          controllers.delete(controller);
          running--;
          if (settled) return;
          const durationMs = Date.now() - start;
          console.log(`ApplyFlow AI: ${model} responded in ${(durationMs / 1000).toFixed(1)}s`);
          finish(resolve, { text: response.text, model, durationMs: Date.now() - callStart });
        })
        .catch((error) => {
          clearTimeout(hedgeTimer);
          controllers.delete(controller);
          running--;
          if (settled) return; // we cancelled this one because another model won

          const classified = classifyGeminiError(error);
          lastError = classified;
          console.warn(
            `ApplyFlow AI: ${model} failed after ${((Date.now() - start) / 1000).toFixed(1)}s ` +
            `[${classified.code}${error?.status ? " " + error.status : ""}]`
          );

          // Auth problems won't be fixed by switching models — stop immediately.
          const retryable =
            RETRYABLE_STATUS.has(classified.status) ||
            classified.code === "GEMINI_TIMEOUT" ||
            classified.code === "GEMINI_MODEL_UNAVAILABLE";
          if (!retryable) return finish(reject, classified);

          // Only start another model if nothing else is still in flight
          // (a still-running model has its own hedge timer).
          if (running === 0) launch();
          failIfNothingLeft();
        });
    };

    launch();
    failIfNothingLeft();
  });
}

/** Call Gemini with a JSON response schema and parse the result. */
export async function callGeminiJson(tier, contents, responseSchema) {
  const result = await callGemini(tier, contents, {
    responseMimeType: "application/json",
    responseSchema
  });
  try {
    return { data: JSON.parse(result.text), model: result.model };
  } catch {
    throw new GeminiError("GEMINI_BAD_OUTPUT", "Gemini returned invalid JSON.", 502);
  }
}
