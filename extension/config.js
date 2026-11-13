// ==========================================
// APPLYFLOW AI — where the backend lives + who this tester is
// ==========================================
// Loaded by every extension page (before common.js) and by background.js.

// The hosted backend. To develop against your own PC instead, change it to
// "http://127.0.0.1:3000" and run the backend with start.bat / start.sh.
const APPLYFLOW_API = "https://applyflow-ai-murex.vercel.app";

// Each install makes one long random "tester ID" and sends it with every request
// (X-ApplyFlow-User header). The backend keeps each tester's resumes, settings and
// Gmail login separate by this ID. It acts like a password: never show or share it.
// Reloading the extension keeps it; removing the extension makes a new one.
let testerIdPromise = null;

function applyflowTesterId() {
  if (!testerIdPromise) {
    testerIdPromise = (async () => {
      const KEY = "applyflowTesterId";
      const saved = (await chrome.storage.local.get(KEY))[KEY];
      if (typeof saved === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(saved)) return saved;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await chrome.storage.local.set({ [KEY]: id });
      // If another page created one at the same moment, use whichever was saved last.
      return (await chrome.storage.local.get(KEY))[KEY] || id;
    })().catch((error) => {
      testerIdPromise = null;
      throw error;
    });
  }
  return testerIdPromise;
}

/** Headers every backend request needs. */
async function applyflowHeaders(extra = {}) {
  return { ...extra, "X-ApplyFlow-User": await applyflowTesterId() };
}
