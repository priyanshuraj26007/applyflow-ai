// ==========================================
// GEMINI PROVIDER (Google)
// ==========================================
// Talks to Gemini only. Choosing models, racing, fallbacks and retries live in
// ./ai-router.js. Override models in .env, e.g.
//   GEMINI_MODELS_FAST=gemini-3.5-flash-lite,gemini-3.5-flash
import { GoogleGenAI } from "@google/genai";

export const parseModels = (value, fallback) =>
  (value || fallback).split(",").map(m => m.trim()).filter(Boolean);

export const GEMINI_TIERS = {
  // Cheap + fast — job post extraction / classification
  fast: parseModels(process.env.GEMINI_MODELS_FAST, "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash"),
  // Stronger — one-time resume analysis (quality matters, speed doesn't)
  smart: parseModels(process.env.GEMINI_MODELS_SMART, "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"),
  // Matching + email while the user waits — fastest model first
  draft: parseModels(process.env.GEMINI_MODELS_DRAFT, "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash"),
  // Resume scoring (runs alongside the email)
  match: parseModels(process.env.GEMINI_MODELS_MATCH || process.env.GEMINI_MODELS_DRAFT, "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash")
};

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;
// The user is waiting on drafts — give up on a stuck model quickly.
const DRAFT_TIMEOUT_MS = Number(process.env.GEMINI_DRAFT_TIMEOUT_MS) || 12000;
const TIER_TIMEOUT_MS = { draft: DRAFT_TIMEOUT_MS, match: DRAFT_TIMEOUT_MS };
export const geminiTimeout = (tier) => TIER_TIMEOUT_MS[tier] || GEMINI_TIMEOUT_MS;

/** Error used by every AI provider. `code` is a short machine-readable reason. */
export class GeminiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export { GeminiError as AIError };

let ai = null;
function client() {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new GeminiError("GEMINI_AUTH", "GEMINI_API_KEY is missing in backend/.env.", 401);
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

/** One request to one Gemini model. Returns the response text. */
export async function geminiGenerate({ model, contents, config = {}, signal, timeout }) {
  try {
    const response = await client().models.generateContent({
      model,
      contents,
      config: { ...config, abortSignal: signal, httpOptions: { timeout } }
    });
    return response.text;
  } catch (error) {
    throw classifyGeminiError(error);
  }
}

// Tests can swap in a fake Gemini client.
export function _setClientForTests(fake) {
  ai = fake;
}
