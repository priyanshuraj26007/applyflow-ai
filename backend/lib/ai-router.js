// ==========================================
// AI ROUTER — providers, racing, fallbacks, retries
// ==========================================
// Every AI request goes through callAI(). It builds an ordered list of
// candidates (provider + model) for the tier, e.g. with AI_PROVIDERS=groq,gemini:
//   groq gpt-oss-120b → groq gpt-oss-20b → gemini-3.5-flash-lite → …
//  - A candidate that FAILS → the next one starts right away.
//  - A candidate that is SLOW (HEDGE_MS, "fast"/"draft" tiers) → the next one is
//    raced in parallel; the first good answer wins, the other is cancelled.
//  - A rejected API key → that provider is skipped; the others still run.
//  - If ALL candidates fail for temporary reasons → wait, then one more round.
import { GeminiError, GEMINI_TIERS, geminiGenerate, geminiTimeout } from "./gemini.js";
import { GROQ_TIERS, groqGenerate, groqTimeout } from "./groq.js";

const PROVIDERS = {
  groq: { tiers: GROQ_TIERS, generate: groqGenerate, timeout: groqTimeout, label: (m) => `groq ${m}` },
  gemini: { tiers: GEMINI_TIERS, generate: geminiGenerate, timeout: geminiTimeout, label: (m) => m }
};

// Order of providers. Default: Groq first when a Groq key exists (fast), Gemini as backup.
export const PROVIDER_ORDER = (process.env.AI_PROVIDERS || (process.env.GROQ_API_KEY ? "groq,gemini" : "gemini"))
  .split(",").map(p => p.trim().toLowerCase()).filter(p => PROVIDERS[p]);

const candidatesFor = (tier) => PROVIDER_ORDER.flatMap(provider =>
  (PROVIDERS[provider].tiers[tier] || []).map(model => ({ provider, model })));

/** Human-readable candidate list per tier (status page + startup log). */
export const MODEL_TIERS = Object.fromEntries(["fast", "smart", "draft", "match"].map(tier =>
  [tier, candidatesFor(tier).map(c => PROVIDERS[c.provider].label(c.model))]));

const HEDGE_MS = Number(process.env.AI_HEDGE_MS || process.env.GEMINI_HEDGE_MS) || 5000;
const HEDGED_TIERS = new Set(["fast", "draft", "match"]);
const RETRY_ROUNDS = Math.max(0, Number(process.env.AI_RETRY_ROUNDS ?? process.env.GEMINI_RETRY_ROUNDS ?? 1));
const RETRY_DELAY_MS = Number(process.env.AI_RETRY_DELAY_MS || process.env.GEMINI_RETRY_DELAY_MS) || 2000;
const RETRY_BUDGET_MS = Number(process.env.AI_RETRY_BUDGET_MS || process.env.GEMINI_RETRY_BUDGET_MS) || 30000;
const MIN_ROUND_MS = Math.min(4000, RETRY_BUDGET_MS / 4);
// Temporary problems: worth another round.
const TRANSIENT_CODES = new Set(["GEMINI_OVERLOADED", "GEMINI_RATE_LIMIT", "GEMINI_TIMEOUT", "GEMINI_ERROR"]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Call the AI for a tier. Returns { text, model, provider, durationMs }.
 * `config` may include responseMimeType + responseSchema (Gemini-style schema).
 */
export async function callAI(tier, contents, config = {}) {
  let candidates = candidatesFor(tier);
  const deadProviders = new Set();           // rejected API key → skip for this call
  const callStart = Date.now();
  const totalRounds = 1 + RETRY_ROUNDS;

  for (let round = 1; ; round++) {
    const pass = await runPass(tier, candidates, deadProviders, contents, config, callStart);
    if (pass.result) return pass.result;

    let error = pass.lastError || new GeminiError("GEMINI_ERROR", "No AI models configured.", 500);
    // Skip retired models and providers with a bad key in the next round.
    candidates = candidates.filter(c => !pass.unavailable.has(c) && !deadProviders.has(c.provider));
    const left = RETRY_BUDGET_MS - (Date.now() - callStart) - RETRY_DELAY_MS;
    if (!pass.transient || round >= totalRounds || candidates.length === 0 || left < MIN_ROUND_MS) {
      if (TRANSIENT_CODES.has(error.code) && PROVIDER_ORDER.length > 1) {
        error = new GeminiError(error.code, "The AI is busy right now (all providers tried). Please try again in a minute.", error.status);
      }
      throw error;
    }
    console.log(
      `ApplyFlow AI: all ${tier} models busy - retrying in ${(RETRY_DELAY_MS / 1000).toFixed(0)}s ` +
      `(round ${round + 1}/${totalRounds})`
    );
    await sleep(RETRY_DELAY_MS);
  }
}

/** One pass through the candidates. Resolves { result } or { lastError, transient, unavailable }. */
function runPass(tier, candidates, deadProviders, contents, config, callStart) {
  const hedge = HEDGED_TIERS.has(tier);

  return new Promise((resolve) => {
    let transient = false;            // did any candidate fail for a temporary reason?
    const unavailable = new Set();    // candidates that answered 404 (retired / no access)
    let nextIndex = 0;
    let running = 0;
    let settled = false;
    let lastError = null;
    const controllers = new Set();

    const finish = (value) => {
      if (settled) return;
      settled = true;
      controllers.forEach(c => c.abort()); // cancel any slower request still running
      resolve(value);
    };
    const fail = () => finish({ lastError, transient, unavailable });

    const skipDead = () => {
      while (nextIndex < candidates.length && deadProviders.has(candidates[nextIndex].provider)) nextIndex++;
    };
    const failIfNothingLeft = () => {
      skipDead();
      if (running === 0 && nextIndex >= candidates.length) fail();
    };

    const launch = () => {
      skipDead();
      if (settled || nextIndex >= candidates.length) return;
      const candidate = candidates[nextIndex++];
      const { provider, model } = candidate;
      const p = PROVIDERS[provider];
      const name = p.label(model);
      const controller = new AbortController();
      controllers.add(controller);
      running++;
      const start = Date.now();

      skipDead();
      const hedgeTimer = hedge && nextIndex < candidates.length
        ? setTimeout(() => {
            if (settled) return;
            skipDead();
            if (nextIndex >= candidates.length) return;
            const next = candidates[nextIndex];
            console.log(`ApplyFlow AI: ${name} is slow (${(HEDGE_MS / 1000).toFixed(0)}s) - also asking ${PROVIDERS[next.provider].label(next.model)}`);
            launch();
          }, HEDGE_MS)
        : null;

      Promise.resolve()
        .then(() => p.generate({ model, contents, config, signal: controller.signal, timeout: p.timeout(tier), tier }))
        .then((text) => {
          clearTimeout(hedgeTimer);
          controllers.delete(controller);
          running--;
          if (settled) return;
          console.log(`ApplyFlow AI: ${name} responded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
          finish({ result: { text, model, provider, durationMs: Date.now() - callStart } });
        })
        .catch((raw) => {
          clearTimeout(hedgeTimer);
          controllers.delete(controller);
          running--;
          if (settled) return; // we cancelled this one because another candidate won

          const error = raw instanceof GeminiError ? raw : new GeminiError("GEMINI_ERROR", "AI request failed.", raw?.status || 500);
          lastError = error;
          console.warn(
            `ApplyFlow AI: ${name} failed after ${((Date.now() - start) / 1000).toFixed(1)}s ` +
            `[${error.code}${error.status ? " " + error.status : ""}${error.detail ? ", " + error.detail : ""}]`
          );

          if (error.code === "GEMINI_AUTH") {
            // Bad/missing key: switching models of THIS provider can't fix it — skip it.
            deadProviders.add(provider);
          } else {
            if (error.code === "GEMINI_MODEL_UNAVAILABLE") unavailable.add(candidate);
            if (TRANSIENT_CODES.has(error.code)) transient = true;
          }

          // Replace the failed candidate straight away — even if another one is
          // still running, so we never sit waiting on a single slow request.
          launch();
          failIfNothingLeft();
        });
    };

    launch();
    failIfNothingLeft();
  });
}

/** Call the AI with a JSON response schema and parse the result. */
export async function callAIJson(tier, contents, responseSchema) {
  const result = await callAI(tier, contents, { responseMimeType: "application/json", responseSchema });
  try {
    return { data: JSON.parse(result.text), model: result.model, provider: result.provider };
  } catch {
    throw new GeminiError("GEMINI_BAD_OUTPUT", "The AI returned invalid JSON.", 502);
  }
}
