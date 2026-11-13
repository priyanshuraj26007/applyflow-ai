// ==========================================
// REQUEST CONTEXT — "which tester is this?"
// ==========================================
// The hosted backend is shared by every tester. Each copy of the extension makes a
// long random ID on install and sends it as the X-ApplyFlow-User header. server.js
// runs the rest of the request inside runAsUser(id, …), and store.js reads the ID
// from here, so every read/write lands in that tester's own space automatically —
// resumes.js, applications.js etc. don't need to pass the ID around.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

// Used outside any request (tests, local scripts) — keeps the old single-user behaviour.
export const LOCAL_USER = "local";

// 32+ random URL-safe characters. Long enough that guessing another tester's ID is hopeless.
export const USER_ID_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function runAsUser(userId, fn) {
  return als.run({ userId, cache: new Map() }, fn);
}

export function currentUserId() {
  return als.getStore()?.userId || LOCAL_USER;
}

/** This request's private cache (a Map), or null outside a request. */
export function requestCache() {
  return als.getStore()?.cache || null;
}

/** Per-request memo (e.g. the tester's AI keys are read once per request, not per AI call). */
export function requestMemo(key, compute) {
  const cache = als.getStore()?.cache;
  if (!cache) return compute();
  if (!cache.has(key)) cache.set(key, Promise.resolve(compute()).catch((error) => { cache.delete(key); throw error; }));
  return cache.get(key);
}

// On Vercel a function may be frozen as soon as the response is sent. waitUntil()
// keeps it alive until background work (resume analysis, About me condensing) ends.
// This is exactly what @vercel/functions' waitUntil does — read Vercel's request
// context directly, so the server doesn't load that package on every cold start.
function waitUntil(promise) {
  const context = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (context?.waitUntil) return context.waitUntil(promise);
  if (process.env.VERCEL) console.warn("ApplyFlow AI: no Vercel request context - background work may be cut short.");
}

/** Run work after the response without blocking it. Never throws. */
export function background(promise) {
  const safe = Promise.resolve(promise).catch((error) => {
    console.error(`ApplyFlow AI: background task failed: ${error?.message}`);
  });
  waitUntil(safe);
  return safe;
}
