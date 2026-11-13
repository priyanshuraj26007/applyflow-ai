// ==========================================
// APPLYFLOW AI — BACKGROUND SERVICE WORKER
// ==========================================
// Messages handled:
//   ANALYZE_POST          (content.js)  → user opened a detected post: AI job summary
//   OPEN_REVIEW           (content.js)  → make sure an application record exists, open review page
//   ANALYZE_TEXT          (popup.js)    → manual analysis of selected text
console.log("ApplyFlow AI: Background service worker started!");

importScripts("config.js"); // APPLYFLOW_API + tester ID helpers
const API = APPLYFLOW_API;

// Make the tester ID as soon as the extension is installed.
chrome.runtime.onInstalled.addListener(() => { applyflowTesterId().catch(() => {}); });
const ANALYZE_TIMEOUT_MS = 65000; // backend may try several AI models
const CACHE_LIMIT = 200;

// Posts being analysed right now (prevents duplicate requests for the same post).
const inFlight = new Map();

// ------------------------------------------
// Backend helper with timeout + friendly errors
// ------------------------------------------
async function api(path, { method = "GET", body, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: await applyflowHeaders(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(
      new Error(timedOut
        ? "The AI is taking too long right now."
        : "Can't reach the ApplyFlow server. Check your internet connection and try again."),
      { code: timedOut ? "TIMEOUT" : "BACKEND_OFFLINE" }
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(new Error("The backend returned an unreadable response."), { code: "BAD_RESPONSE" });
  }
  if (!response.ok || !data?.success) {
    throw Object.assign(new Error(data?.error || `Backend error (${response.status}).`), {
      code: data?.errorCode || "BACKEND_ERROR",
      duplicates: data?.duplicates
    });
  }
  return data;
}

// Run an async handler and reply to the sender with { success, ...result } or the error.
function respond(sendResponse, fn) {
  fn()
    .then(result => sendResponse({ success: true, ...result }))
    .catch(error => sendResponse({
      success: false,
      error: error.message,
      errorCode: error.code,
      duplicates: error.duplicates
    }));
  return true; // keep the message channel open for the async reply
}

// Create an application record from local data when Gemini was unavailable.
async function ensureApplication(message) {
  if (message.applicationId) return message.applicationId;
  const result = await api("/api/applications", {
    method: "POST",
    body: { postText: message.postText, sourceUrl: message.sourceUrl, job: message.localJob }
  });
  return result.application.id;
}

const appPath = (id) => `/api/applications/${encodeURIComponent(id)}`;

// ------------------------------------------
// Session cache: don't re-analyse posts already analysed (saves Gemini quota)
// ------------------------------------------
async function getCached(postKey) {
  try {
    const { analysisCache = {} } = await chrome.storage.session.get("analysisCache");
    return analysisCache[postKey] || null;
  } catch {
    return null;
  }
}

async function setCached(postKey, value) {
  try {
    const { analysisCache = {} } = await chrome.storage.session.get("analysisCache");
    analysisCache[postKey] = { ...value, at: Date.now() };
    const keys = Object.keys(analysisCache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort((a, b) => analysisCache[a].at - analysisCache[b].at)
        .slice(0, keys.length - CACHE_LIMIT)
        .forEach(k => delete analysisCache[k]);
    }
    await chrome.storage.session.set({ analysisCache });
  } catch {
    // Cache is an optimisation only.
  }
}

async function analysePost({ postKey, postText, sourceUrl, force = false }) {
  const cached = postKey && await getCached(postKey);
  if (cached) return cached;

  // "Try again" (force) starts a fresh request instead of waiting on a stuck one.
  if (postKey && inFlight.has(postKey) && !force) return inFlight.get(postKey);

  const promise = (async () => {
    const result = await api("/api/analyze-job", {
      method: "POST",
      body: { postText, sourceUrl },
      timeout: ANALYZE_TIMEOUT_MS
    });
    const value = {
      jobData: result.job,
      applicationId: result.applicationId,
      model: result.model,
      alreadyApplied: !!result.alreadyApplied
    };
    if (postKey) await setCached(postKey, value);
    return value;
  })();

  if (postKey) inFlight.set(postKey, promise);
  try {
    return await promise;
  } finally {
    if (postKey && inFlight.get(postKey) === promise) inFlight.delete(postKey);
  }
}

// ------------------------------------------
// Message router
// ------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // The user opened a detected post → read it with the AI (job summary only).
  // Posts that are only scrolled past never reach the AI, which saves quota.
  if (message.type === "ANALYZE_POST") {
    return respond(sendResponse, async () => {
      console.log("ApplyFlow AI: Reading post with the AI...");
      const result = await analysePost({ postKey: message.postId, postText: message.postText, sourceUrl: message.sourceUrl, force: !!message.force });
      return result;
    });
  }

  // Opens the full Review page in a new tab (optional "Open full page ↗" link).
  if (message.type === "OPEN_REVIEW") {
    return respond(sendResponse, async () => {
      const applicationId = await ensureApplication(message);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(applicationId)}`) });
      return { applicationId };
    });
  }

  if (message.type === "OPEN_DASHBOARD") {
    return respond(sendResponse, async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${message.hash || ""}`) });
      return {};
    });
  }

  // ---------- In-page panel (LinkedIn) ----------

  // Resume list + Gmail status for the panel.
  if (message.type === "GET_CONTEXT") {
    return respond(sendResponse, async () => {
      const [resumeData, gmail] = await Promise.all([
        api("/api/resumes"),
        api("/api/gmail/status").catch(() => ({ configured: false, connected: false }))
      ]);
      return {
        resumes: resumeData.resumes.map(r => ({ id: r.id, label: r.label, originalName: r.originalName, analysed: !!r.profile })),
        gmail: { configured: gmail.configured, connected: gmail.connected, email: gmail.email }
      };
    });
  }

  // Match resumes + draft the email (one Gemini call). Returns the full application.
  if (message.type === "PREPARE_DRAFT") {
    return respond(sendResponse, async () => {
      const applicationId = await ensureApplication(message);
      const body = {};
      if (message.resumeId) body.resumeId = message.resumeId;
      if (message.regenerateEmail) body.regenerateEmail = true;
      const result = await api(`${appPath(applicationId)}/prepare`, { method: "POST", body, timeout: 90000 });
      return { application: result.application, duplicates: result.duplicates };
    });
  }

  // Save the user's edits to the draft.
  if (message.type === "SAVE_DRAFT") {
    return respond(sendResponse, async () => {
      const result = await api(appPath(message.applicationId), { method: "PATCH", body: { email: message.email } });
      return { application: result.application };
    });
  }

  // Send — only ever triggered by the user's Send + Confirm clicks in the panel.
  if (message.type === "SEND_APPLICATION") {
    return respond(sendResponse, async () => {
      const result = await api(`${appPath(message.applicationId)}/send`, {
        method: "POST",
        body: {
          to: message.to,
          subject: message.subject,
          body: message.body,
          resumeId: message.resumeId,
          confirm: message.confirm === true,
          allowDuplicate: message.allowDuplicate === true
        },
        timeout: 60000
      });
      return { application: result.application };
    });
  }

  if (message.type === "ANALYZE_TEXT") {
    (async () => {
      try {
        const result = await analysePost({ postText: message.postText, sourceUrl: message.sourceUrl });
        sendResponse({ success: true, ...result });
      } catch (error) {
        sendResponse({ success: false, error: error.message, errorCode: error.code });
      }
    })();
    return true;
  }
});
