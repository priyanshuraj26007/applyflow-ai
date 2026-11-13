// ==========================================
// APPLYFLOW AI — shared helpers for extension pages
// (review.html, dashboard.html, popup.html) — load config.js first.
// ==========================================
const API_BASE = APPLYFLOW_API;

/** Call the ApplyFlow backend. Throws Error with .code on failure. */
async function api(path, { method = "GET", body, form, timeout = 30000 } = {}) {
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers: await applyflowHeaders(body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(new Error(timedOut
      ? "The request took too long. The AI may be busy — please try again."
      : "Can't reach the ApplyFlow server. Check your internet connection and try again."),
      { code: timedOut ? "TIMEOUT" : "BACKEND_OFFLINE" });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw Object.assign(new Error(data?.error || `Backend error (${response.status}).`),
      { code: data?.errorCode || "BACKEND_ERROR", data, status: response.status });
  }
  return data;
}

/** Open a resume PDF in a new tab (a plain link can't carry the tester ID, so fetch it first). */
async function openResumePdf(resumeId) {
  const tab = window.open("about:blank", "_blank"); // open now, while the click still counts
  try {
    const response = await fetch(`${API_BASE}/api/resumes/${encodeURIComponent(resumeId)}/file`, {
      headers: await applyflowHeaders()
    });
    if (!response.ok) throw new Error("Couldn't load the PDF.");
    const url = URL.createObjectURL(await response.blob());
    if (tab) tab.location.href = url; else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    tab?.close();
    toast(error.message || "Couldn't load the PDF.", "error");
  }
}

/** Ask the backend for a Google sign-in link for this tester, then open it. */
async function connectGmail() {
  try {
    const { url } = await api("/api/gmail/connect", { method: "POST" });
    window.open(url, "_blank");
  } catch (error) {
    toast(error.message, "error");
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function $(selector, root = document) { return root.querySelector(selector); }
function $all(selector, root = document) { return [...root.querySelectorAll(selector)]; }

function formatDate(iso, withTime = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    (withTime ? " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
}

let toastTimer;
function toast(message, type = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `show ${type === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, type === "error" ? 6000 : 3000);
}

/** Promise-based confirm dialog. Returns true/false. */
function confirmDialog({ title, html, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `
      <div class="dialog-body">
        <h2 style="font-size:17px;margin-bottom:10px">${esc(title)}</h2>
        <div>${html}</div>
      </div>
      <div class="dialog-actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(confirmText)}</button>
      </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (e) => {
      const v = e.target.closest("button")?.value;
      if (v) dialog.close(v);
    });
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    dialog.showModal();
    dialog.querySelector('button[value="ok"]').focus();
  });
}

const STATUS_STYLE = {
  "Detected": "", "Analysed": "", "Ready to Apply": "warn", "Applied": "ok",
  "Interview": "ok", "Rejected": "danger", "No Response": ""
};
function statusBadge(status) {
  return `<span class="badge ${STATUS_STYLE[status] || ""}"><span class="dot"></span>${esc(status)}</span>`;
}

// Monochrome UI: scores are shown as rings; text uses the normal text colour.
function scoreColor() {
  return "var(--text)";
}
