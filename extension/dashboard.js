// ==========================================
// APPLYFLOW AI — DASHBOARD
// Tabs: Applications · Resumes · Settings
// ==========================================
const CATEGORIES = [
  ["Product", "Product Management"], ["Analyst", "Data / Business Analyst"], ["Operations", "Operations"],
  ["Consulting", "Consulting"], ["Software Engineering", "Software Engineering"], ["Core Engineering", "Core Engineering"],
  ["Sales", "Sales"], ["Marketing", "Marketing"], ["Finance", "Finance"], ["HR", "HR"], ["General", "General / Other"]
];

let applications = [];
let statuses = [];
let resumes = [];
let pollTimer = null;

// ------------------------------------------
// Tabs (remembers the tab via the URL hash, e.g. dashboard.html#resumes)
// ------------------------------------------
function showTab(name) {
  if (!["applications", "resumes", "settings"].includes(name)) name = "applications";
  $all(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "applications") loadApplications();
  if (name === "resumes") loadResumes();
  if (name === "settings") loadSettings();
}
$all(".tab").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------- "Live / Offline" badge ----------
// Updated by EVERY request this page makes (common.js reports each answer), plus a
// light check on open, every minute, and when you come back to this tab. A slow or
// failed check is retried, so the badge can never get stuck on "Checking…".
function setConnection(state) {
  const live = state === "live";
  $("#offlineBanner").classList.toggle("hidden", live);
  $("#backendDot").className = `badge ${live ? "ok" : "danger"}`;
  $("#backendText").textContent = live ? "Live" : "Offline";
}
window.addEventListener("applyflow:connection", (e) => setConnection(e.detail));

function handleError(error) {
  if (error.code !== "BACKEND_OFFLINE") toast(error.message, "error"); // offline → badge + banner
}

let checkTimer = null;
async function checkBackend() {
  clearTimeout(checkTimer);
  try {
    await api("/api/status", { timeout: 15000 }); // the badge updates itself from the answer
    checkTimer = setTimeout(checkBackend, 60000);
  } catch {
    checkTimer = setTimeout(checkBackend, 5000);   // offline or slow: try again soon
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkBackend(); });

// ==========================================
// APPLICATIONS
// ==========================================
async function loadApplications() {
  try {
    const [appData, resumeData] = await Promise.all([api("/api/applications"), api("/api/resumes")]);
    applications = appData.applications;
    statuses = appData.statuses;
    resumes = resumeData.resumes;

    const filter = $("#appFilter");
    if (filter.options.length <= 1) {
      filter.insertAdjacentHTML("beforeend", statuses.map(s => `<option>${esc(s)}</option>`).join(""));
    }
    renderApplications();
  } catch (error) {
    handleError(error);
  }
}

function renderApplications() {
  $("#statTotal").textContent = applications.length;
  $("#statReady").textContent = applications.filter(a => a.status === "Ready to Apply").length;
  $("#statApplied").textContent = applications.filter(a => a.appliedAt).length;
  $("#statInterview").textContent = applications.filter(a => a.status === "Interview").length;

  const q = $("#appSearch").value.trim().toLowerCase();
  const status = $("#appFilter").value;
  const rows = applications.filter(a => {
    if (status && a.status !== status) return false;
    if (!q) return true;
    const j = a.job || {};
    return [j.jobTitle, j.company, j.recruiter, j.email, j.location, a.notes].join(" ").toLowerCase().includes(q);
  });

  $("#appEmpty").classList.toggle("hidden", rows.length > 0);
  $("#appEmpty").textContent = applications.length
    ? "No applications match your search."
    : "No opportunities yet. Browse your LinkedIn feed — hiring posts will appear here automatically.";

  $("#appRows").innerHTML = rows.map(a => {
    const j = a.job || {};
    const resume = resumes.find(r => r.id === a.resumeId);
    return `
      <tr data-id="${esc(a.id)}">
        <td class="role">
          <strong>${esc(j.jobTitle || "Untitled role")}</strong>
          <span class="muted small">${esc([j.company, j.location].filter(Boolean).join(" · ") || "—")}</span>
        </td>
        <td>${esc(j.recruiter || "—")}<div class="muted small">${esc(j.email || "no email")}</div></td>
        <td class="small">${esc(formatDate(a.detectedAt))}</td>
        <td class="small">${a.schedule?.status === "scheduled"
          ? `<span class="sched">${AF_ICONS.clock(13)}${esc(AF_SCHEDULE.label(a.schedule.sendAt))}</span>`
          : a.schedule?.status === "failed"
            ? `<span class="sched failed" title="${esc(a.schedule.error || "")}">${AF_ICONS.warning(13)}Scheduled send failed</span>`
            : esc(formatDate(a.appliedAt))}</td>
        <td class="small">${esc(resume?.label || "—")}</td>
        <td>
          <select data-action="status" aria-label="Status">
            ${statuses.map(s => `<option ${s === a.status ? "selected" : ""}>${esc(s)}</option>`).join("")}
          </select>
        </td>
        <td class="actions">
          ${a.sourceUrl ? `<a class="btn small" href="${esc(a.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="Open LinkedIn post" aria-label="Open LinkedIn post">${AF_ICONS.external(14)}</a>` : ""}
          <a class="btn small primary" href="review.html?id=${encodeURIComponent(a.id)}" target="_blank">${a.appliedAt ? "Open" : a.schedule?.status === "failed" ? "Fix" : "Review"}</a>
          <button class="btn small danger" data-action="delete" title="Delete" aria-label="Delete">${AF_ICONS.trash(14)}</button>
        </td>
      </tr>`;
  }).join("");
}

$("#appSearch").addEventListener("input", renderApplications);
$("#appFilter").addEventListener("change", renderApplications);
$("#refreshApps").addEventListener("click", loadApplications);

$("#appRows").addEventListener("change", async (e) => {
  if (e.target.dataset.action !== "status") return;
  const id = e.target.closest("tr").dataset.id;
  try {
    const data = await api(`/api/applications/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: e.target.value } });
    Object.assign(applications.find(a => a.id === id), data.application);
    renderApplications();
    toast(`Status updated to ${e.target.value}.`);
  } catch (error) {
    handleError(error);
  }
});

$("#appRows").addEventListener("click", async (e) => {
  if (e.target.closest("[data-action]")?.dataset.action !== "delete") return;
  const id = e.target.closest("tr").dataset.id;
  const a = applications.find(x => x.id === id);
  const ok = await confirmDialog({
    title: "Delete this opportunity?",
    html: `<strong>${esc(a?.job?.jobTitle || "This item")}</strong> will be removed from your history. This can't be undone.`,
    confirmText: "Delete", danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
    applications = applications.filter(x => x.id !== id);
    renderApplications();
  } catch (error) {
    handleError(error);
  }
});

// ==========================================
// RESUMES
// ==========================================
$("#upCategory").innerHTML = CATEGORIES.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");

async function loadResumes() {
  try {
    resumes = (await api("/api/resumes")).resumes;
    renderResumes();
    schedulePoll();
  } catch (error) {
    handleError(error);
  }
  checkOldLibrary();
}

// While Gemini is analysing a resume, refresh every 3 seconds.
function schedulePoll() {
  clearTimeout(pollTimer);
  if (resumes.some(r => ["pending", "analysing"].includes(r.analysisStatus))) {
    pollTimer = setTimeout(async () => {
      try {
        resumes = (await api("/api/resumes")).resumes;
        renderResumes();
      } catch { /* try again next tick */ }
      schedulePoll();
    }, 3000);
  }
}

function analysisBadge(r) {
  switch (r.analysisStatus) {
    case "done": return `<span class="badge ok"><span class="dot"></span>Ready</span>`;
    case "failed": return `<span class="badge danger"><span class="dot"></span>Analysis failed</span>`;
    default: return `<span class="badge"><span class="spinner" style="width:11px;height:11px"></span>Analysing</span>`;
  }
}

function list(items, max = 6) {
  if (!items?.length) return `<span class="muted small">—</span>`;
  return `<ul>${items.slice(0, max).map(i => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function renderResumes() {
  $("#resumeEmpty").classList.toggle("hidden", resumes.length > 0);
  $("#resumeList").innerHTML = resumes.map(r => {
    const p = r.profile;
    return `
      <div class="card resume" data-id="${esc(r.id)}">
        <div class="resume-head">
          <div class="resume-title">
            <input type="text" value="${esc(r.label)}" data-action="rename" maxlength="80" aria-label="Resume name">
            <div class="resume-meta">${esc(r.originalName)} · ${r.pages || "?"} page${r.pages === 1 ? "" : "s"} · ${(r.size / 1024).toFixed(0)} KB · updated ${esc(formatDate(r.updatedAt))}</div>
          </div>
          <select data-action="category" style="width:auto" aria-label="Category">
            ${CATEGORIES.map(([v, l]) => `<option value="${esc(v)}" ${v === r.category ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
          ${r.isDefault ? `<span class="badge solid">Default</span>` : ""}
          ${analysisBadge(r)}
        </div>

        ${r.analysisStatus === "failed" ? `<div class="banner warn" style="margin:12px 0 0">${esc(r.analysisError || "The AI couldn't analyse this resume.")}</div>` : ""}

        ${p ? `
          <div class="resume-body">
            <div>
              <div class="sub">Profile</div>
              <div style="font-size:13px">${esc(p.headline || p.summary || "—")}</div>
              ${p.totalExperienceYears != null ? `<div class="muted small" style="margin-top:4px">${esc(p.totalExperienceYears)} years full-time experience</div>` : ""}
            </div>
            <div>
              <div class="sub">Best suited for</div>
              <div class="chips">${(p.suitableRoles || []).map(x => `<span class="chip">${esc(x)}</span>`).join("") || "—"}</div>
            </div>
            <div>
              <div class="sub">Skills & tools</div>
              <div class="chips">${[...(p.skills || []), ...(p.tools || [])].slice(0, 18).map(x => `<span class="chip">${esc(x)}</span>`).join("") || "—"}</div>
            </div>
            <div>
              <div class="sub">Experience</div>
              ${list((p.experience || []).map(e => `${e.role}${e.organisation ? " — " + e.organisation : ""}${e.isInternship ? " (internship)" : ""}`), 5)}
            </div>
            <div>
              <div class="sub">Projects</div>
              ${list((p.projects || []).map(x => x.name), 5)}
            </div>
            <div>
              <div class="sub">Education & certifications</div>
              ${list([...(p.education || []), ...(p.certifications || [])], 5)}
            </div>
          </div>` : ""}

        <div class="resume-actions">
          <button class="btn small" data-action="view">View PDF</button>
          ${r.isDefault ? "" : `<button class="btn small" data-action="default">Set as default</button>`}
          <button class="btn small" data-action="replace">Replace PDF</button>
          <button class="btn small" data-action="reanalyse">Re-analyse</button>
          <span class="spacer"></span>
          <button class="btn small danger" data-action="delete">Delete</button>
        </div>
      </div>`;
  }).join("");
}

async function patchResume(id, body, message) {
  try {
    const data = await api(`/api/resumes/${encodeURIComponent(id)}`, { method: "PATCH", body });
    if (body.isDefault) resumes.forEach(r => { r.isDefault = r.id === id; });
    Object.assign(resumes.find(r => r.id === id), data.resume);
    renderResumes();
    if (message) toast(message);
  } catch (error) {
    handleError(error);
  }
}

$("#resumeList").addEventListener("change", (e) => {
  const id = e.target.closest(".resume")?.dataset.id;
  if (!id) return;
  if (e.target.dataset.action === "rename") patchResume(id, { label: e.target.value }, "Resume renamed.");
  if (e.target.dataset.action === "category") patchResume(id, { category: e.target.value }, "Category updated.");
});

let replaceTarget = null;
$("#resumeList").addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  const id = e.target.closest(".resume")?.dataset.id;
  if (!id || !action || ["rename", "category"].includes(action)) return;
  const r = resumes.find(x => x.id === id);

  if (action === "default") patchResume(id, { isDefault: true }, `${r.label} is now your default resume.`);

  if (action === "view") openResumePdf(id);

  if (action === "replace") {
    replaceTarget = id;
    $("#replaceInput").value = "";
    $("#replaceInput").click();
  }

  if (action === "reanalyse") {
    r.analysisStatus = "analysing";
    renderResumes();
    try {
      const data = await api(`/api/resumes/${encodeURIComponent(id)}/analyze`, { method: "POST", timeout: 90000 });
      Object.assign(r, data.resume);
      renderResumes();
      toast(r.analysisStatus === "done" ? "Resume analysed." : "Analysis failed — see the message on the card.", r.analysisStatus === "done" ? "info" : "error");
    } catch (error) {
      handleError(error);
      loadResumes();
    }
  }

  if (action === "delete") {
    const ok = await confirmDialog({
      title: "Delete resume?",
      html: `<strong>${esc(r.label)}</strong> and its PDF will be permanently deleted from your computer.`,
      confirmText: "Delete", danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/resumes/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Resume deleted.");
      loadResumes();
    } catch (error) {
      handleError(error);
    }
  }
});

$("#replaceInput").addEventListener("change", async () => {
  const file = $("#replaceInput").files[0];
  if (!file || !replaceTarget) return;
  const form = new FormData();
  form.append("file", file);
  try {
    await api(`/api/resumes/${encodeURIComponent(replaceTarget)}/file`, { method: "PUT", form, timeout: 60000 });
    toast("PDF replaced — re-analysing with AI…");
    loadResumes();
  } catch (error) {
    handleError(error);
  }
});

async function uploadResume(file, label, category) {
  const form = new FormData();
  form.append("file", file);
  if (label) form.append("label", label);
  form.append("category", category);
  return api("/api/resumes", { method: "POST", form, timeout: 60000 });
}

$("#uploadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#upFile").files[0];
  if (!file) return toast("Please choose a PDF file.", "error");
  if (file.size > 5 * 1024 * 1024) return toast("Resume must be 5 MB or smaller.", "error");
  $("#upBtn").disabled = true;
  $("#upBtn").innerHTML = `<span class="spinner"></span> Uploading…`;
  try {
    await uploadResume(file, $("#upLabel").value.trim(), $("#upCategory").value);
    $("#uploadForm").reset();
    toast("Uploaded! The AI is analysing it now…");
    loadResumes();
  } catch (error) {
    handleError(error);
  } finally {
    $("#upBtn").disabled = false;
    $("#upBtn").textContent = "Upload & analyse";
  }
});

// ------------------------------------------
// Import from the OLD in-browser resume library (IndexedDB "ApplyFlowResumes")
// ------------------------------------------
function readOldLibrary() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open("ApplyFlowResumes");
    } catch {
      return resolve([]);
    }
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("resumes")) { db.close(); return resolve([]); }
      const get = db.transaction("resumes", "readonly").objectStore("resumes").getAll();
      get.onsuccess = () => { db.close(); resolve((get.result || []).filter(r => r.file instanceof Blob)); };
      get.onerror = () => { db.close(); resolve([]); };
    };
  });
}

async function checkOldLibrary() {
  const { oldLibraryImported } = await chrome.storage.local.get("oldLibraryImported").catch(() => ({}));
  if (oldLibraryImported) return;
  const old = await readOldLibrary();
  if (!old.length) return;
  $("#migrateText").textContent = `Found ${old.length} resume${old.length === 1 ? "" : "s"} in your old ApplyFlow library (from the earlier version).`;
  $("#migrateBanner").classList.remove("hidden");
}

$("#migrateBtn").addEventListener("click", async () => {
  const old = await readOldLibrary();
  $("#migrateBtn").disabled = true;
  let ok = 0;
  for (const r of old) {
    try {
      const label = String(r.name || "Resume").replace(/\.pdf$/i, "");
      const category = CATEGORIES.some(([v]) => v === r.category) ? r.category : "General";
      await uploadResume(new File([r.file], r.name || "resume.pdf", { type: "application/pdf" }), label, category);
      ok++;
    } catch (error) {
      toast(`Couldn't import ${r.name}: ${error.message}`, "error");
    }
  }
  await chrome.storage.local.set({ oldLibraryImported: true }).catch(() => {});
  $("#migrateBanner").classList.add("hidden");
  toast(`Imported ${ok} of ${old.length} resumes. The AI is analysing them…`);
  loadResumes();
});

// ==========================================
// SETTINGS
// ==========================================
// Rule: never overwrite what the user is typing. The fields are filled from the server
// only when there are no unsaved changes. Coming back to this tab (or picking a Chrome
// autofill suggestion) only refreshes the Gmail and About me status.
let settingsDirty = false;

function setDirty(dirty) {
  settingsDirty = dirty;
  $all(".unsaved-note").forEach(el => el.classList.toggle("hidden", !dirty));
}
// "input" also fires for Chrome autofill and paste.
["#settingsForm", "#keyForm"].forEach(sel => $(sel).addEventListener("input", () => setDirty(true)));
window.addEventListener("beforeunload", (e) => {
  if (settingsDirty) { e.preventDefault(); e.returnValue = ""; }
});

async function loadSettings() {
  try {
    const [settingsData, status, resumeData] = await Promise.all([
      api("/api/settings"), api("/api/status"), api("/api/resumes").catch(() => ({ resumes: [] }))
    ]);
    const s = settingsData.settings;
    aboutMePrompt = settingsData.aboutMePrompt || "";
    defaultSkeleton = settingsData.defaultSkeleton || "";
    if (!settingsDirty) {
      for (const el of $("#settingsForm").elements) {
        if (el.name && s[el.name] !== undefined) el.value = s[el.name];
      }
      if (!$("#sSkeleton").value.trim()) $("#sSkeleton").value = defaultSkeleton;
      renderKeys(s.keys || {});
    }
    setupContactSuggestions(resumeData.resumes || []);
    renderAboutMe(settingsData.aboutMe);
    renderGmail(status.gmail);
    renderModels(status);
  } catch (error) {
    handleError(error);
  }
}

// ---------- Name / phone / LinkedIn from your resume ----------
// Chrome's autofill can't fill extension pages reliably, so ApplyFlow offers the details
// it already read from your resumes: as dropdown suggestions on each field, a "Fill from
// my resume" button, and automatically when the fields are still empty.
let resumeContact = null;

function setupContactSuggestions(resumes) {
  const ordered = [...resumes].sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  const unique = (key) => [...new Set(ordered.map(r => r.contact?.[key]).filter(Boolean))];
  const lists = { dlName: unique("name"), dlPhone: unique("phone"), dlLinkedin: unique("linkedin") };
  for (const [id, values] of Object.entries(lists)) {
    $(`#${id}`).innerHTML = values.map(v => `<option value="${esc(v)}"></option>`).join("");
  }
  resumeContact = { name: lists.dlName[0], phone: lists.dlPhone[0], linkedin: lists.dlLinkedin[0] };
  const any = Object.values(resumeContact).some(Boolean);
  $("#fillFromResume").classList.toggle("hidden", !any);
  $("#fillHint").textContent = any ? "" : "Tip: upload your resume and ApplyFlow can fill these in for you.";
  if (any && !settingsDirty && fillContactFromResume({ onlyEmpty: true })) {
    $("#fillHint").textContent = "Filled in from your resume. Check it, then press Save.";
  }
}

/** Put the resume's details into the fields. Returns true if anything changed. */
function fillContactFromResume({ onlyEmpty = false } = {}) {
  if (!resumeContact) return false;
  let changed = false;
  for (const [sel, value] of [["#sName", resumeContact.name], ["#sPhone", resumeContact.phone], ["#sLinkedin", resumeContact.linkedin]]) {
    const el = $(sel);
    if (!value || (onlyEmpty && el.value.trim()) || el.value === value) continue;
    el.value = value;
    changed = true;
  }
  if (changed) setDirty(true);
  return changed;
}

$("#fillFromResume").addEventListener("click", () => {
  if (fillContactFromResume()) $("#fillHint").textContent = "Filled in from your resume. Check it, then press Save.";
  else toast("These already match your resume.");
});

/** Light refresh: status only, never touches the form fields. */
async function refreshSettingsStatus() {
  try {
    const [settingsData, status] = await Promise.all([api("/api/settings"), api("/api/status")]);
    renderAboutMe(settingsData.aboutMe);
    renderGmail(status.gmail);
    renderModels(status);
    if (!settingsDirty) renderKeys(settingsData.settings.keys || {});
  } catch { /* offline is reported by checkBackend */ }
}

function renderModels(status) {
  $("#geminiInfo").innerHTML = `
    <dt>Draft models</dt><dd>${esc((status.models.draft || []).join(" → "))}</dd>
    <dt>Fast models</dt><dd>${esc(status.models.fast.join(" → "))}</dd>
    <dt>Smart models</dt><dd>${esc(status.models.smart.join(" → "))}</dd>
    <dt>Resumes analysed</dt><dd>${status.analysedResumes} of ${status.resumes}</dd>`;
}

function renderGmail(g) {
  const box = $("#gmailBox");
  if (!g.configured) {
    box.innerHTML = `
      <div class="banner warn">Gmail sending isn't switched on for this ApplyFlow server yet. You can still copy each email and send it yourself.</div>`;
  } else if (!g.connected) {
    box.innerHTML = `
      <p style="margin-top:0">Connect the Gmail account you apply from. ApplyFlow only asks for permission to <b>send</b> email — it can't read your inbox, and your password is never shared.</p>
      <p class="muted small">ApplyFlow is in testing, so your Gmail address must first be added as a tester. Send it to the person who invited you. Google will then say <i>“Google hasn't verified this app”</i>: click <b>Continue</b>.</p>
      <button class="btn primary" id="gmailConnect">Connect Gmail</button>`;
    $("#gmailConnect").onclick = connectGmail;
  } else {
    box.innerHTML = `
      <p style="margin-top:0" class="row"><span class="badge ok"><span class="dot"></span>Connected</span><strong>${esc(g.email || "your Gmail account")}</strong></p>
      <button class="btn small danger" id="gmailDisconnect">Disconnect</button>`;
    $("#gmailDisconnect").onclick = async () => {
      if (!(await confirmDialog({ title: "Disconnect Gmail?", html: "ApplyFlow will no longer be able to send emails until you reconnect.", confirmText: "Disconnect", danger: true }))) return;
      try {
        await api("/api/gmail/disconnect", { method: "POST" });
        toast("Gmail disconnected.");
        refreshSettingsStatus();
      } catch (error) {
        handleError(error);
      }
    };
  }
}

// ---------- The tester's own AI keys ----------
function renderKeys(keys) {
  $("#kGroq").value = "";
  $("#kGemini").value = "";
  $("#kGroq").placeholder = keys.groq ? `Saved: ${keys.groq} (paste a new key to replace it)` : "gsk_…";
  $("#kGemini").placeholder = keys.gemini ? `Saved: ${keys.gemini} (paste a new key to replace it)` : "Paste your Gemini key";
  if (!$("#keyStatus").dataset.result) {
    $("#keyStatus").textContent = keys.groq ? "✓ Groq key saved" : "No key yet: ApplyFlow can't use AI until you add one.";
  }
  $("#aiKeyCard").classList.toggle("needs-key", !keys.groq);
}

/** One tiny AI request with just that provider's key. */
async function testKey(provider) {
  const name = provider === "groq" ? "Groq" : "Gemini";
  try {
    const r = await api(`/api/test-gemini?provider=${provider}`, { timeout: 70000 });
    return `✓ ${name} key works (replied in ${r.responseTime})`;
  } catch (error) {
    return `✗ ${name}: ${error.message}`;
  }
}

// ---------- One save for everything ----------
let saving = false;
async function saveAllSettings() {
  if (saving) return;
  saving = true;
  const body = {};
  for (const el of $("#settingsForm").elements) if (el.name) body[el.name] = el.value;
  // Store an unchanged default skeleton as "" so future improvements to the default apply.
  if (body.emailSkeleton?.trim() === defaultSkeleton.trim()) body.emailSkeleton = "";
  const newKeys = [];
  if ($("#kGroq").value.trim()) { body.groqApiKey = $("#kGroq").value.trim(); newKeys.push("groq"); }
  if ($("#kGemini").value.trim()) { body.geminiApiKey = $("#kGemini").value.trim(); newKeys.push("gemini"); }

  $all(".save-state").forEach(el => { el.innerHTML = `<span class="spinner"></span> Saving…`; });
  try {
    const saved = await api("/api/settings", { method: "PUT", body });
    setDirty(false);
    delete $("#keyStatus").dataset.result;
    renderKeys(saved.settings.keys || {});
    renderAboutMe(saved.aboutMe);
    $all(".save-state").forEach(el => { el.textContent = "✓ Saved"; });
    setTimeout(() => $all(".save-state").forEach(el => { if (el.textContent === "✓ Saved") el.textContent = ""; }), 3000);
    if (newKeys.length) {
      $("#keyStatus").innerHTML = `<span class="spinner"></span> Checking your key${newKeys.length > 1 ? "s" : ""}…`;
      const results = await Promise.all(newKeys.map(testKey));
      $("#keyStatus").dataset.result = "1";
      $("#keyStatus").innerHTML = results.map(esc).join("<br>");
    }
  } catch (error) {
    $all(".save-state").forEach(el => { el.textContent = ""; });
    if (error.code === "BAD_API_KEY") {
      $("#keyStatus").dataset.result = "1";
      $("#keyStatus").textContent = error.message;
    }
    handleError(error);
  } finally {
    saving = false;
  }
}

$("#keyForm").addEventListener("submit", (e) => { e.preventDefault(); saveAllSettings(); });
$("#settingsForm").addEventListener("submit", (e) => { e.preventDefault(); saveAllSettings(); });

// ---------- About me (context from the user's own AI) ----------
let aboutMePrompt = "";
let defaultSkeleton = "";
let aboutPollTimer = null;

function renderAboutMe(state) {
  const status = $("#aboutStatus");
  const box = $("#aboutCompactBox");
  clearTimeout(aboutPollTimer);
  box.classList.add("hidden");
  if (!state || state.status === "none") {
    status.textContent = "Not added yet — emails will use your resume only.";
  } else if (state.status === "condensing" || state.status === "pending") {
    const p = state.progress;
    const step = p?.total > 1 ? ` (part ${Math.min(p.done + 1, p.total)} of ${p.total})` : "";
    status.innerHTML = `<span class="spinner"></span> Condensing your profile into a short fact sheet${step}… ` +
      `<span class="muted">Long profiles can take a few minutes. You can leave this page; it keeps going.</span>`;
    aboutPollTimer = setTimeout(refreshAboutMe, 4000);
  } else if (state.status === "ready") {
    status.textContent = `✓ Ready — condensed from ${state.sourceWords} to ${state.words} words. Every email now uses it.`;
    $("#aboutCompact").textContent = state.compact || "";
    box.classList.remove("hidden");
  } else if (state.status === "failed") {
    status.textContent = `Couldn't condense it yet (${state.error || "AI busy"}). Emails still use your full profile. Press Save to try again.`;
  }
}

async function refreshAboutMe() {
  try {
    renderAboutMe((await api("/api/settings")).aboutMe);
  } catch { /* backend offline is reported elsewhere */ }
}

$("#copyAboutPrompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(aboutMePrompt);
    toast("Prompt copied — paste it into ChatGPT, Claude or Gemini.");
  } catch {
    toast("Couldn't copy automatically. Open the dashboard in a normal tab and try again.", "error");
  }
});

$("#resetSkeleton").addEventListener("click", () => {
  $("#sSkeleton").value = defaultSkeleton;
  setDirty(true);
  toast("Skeleton reset — press Save to keep it.");
});

$("#testGemini").addEventListener("click", async () => {
  const out = $("#testGeminiResult");
  out.innerHTML = `<span class="spinner"></span>`;
  try {
    const r = await api("/api/test-gemini", { timeout: 70000 });
    out.textContent = `${r.model} replied in ${r.responseTime}`;
  } catch (error) {
    out.textContent = `Failed: ${error.message}`;
  }
});

// Back from another tab (e.g. Google sign-in or ChatGPT) → refresh status only.
window.addEventListener("focus", () => {
  if (!$("#tab-settings").classList.contains("hidden")) refreshSettingsStatus();
});

// ------------------------------------------
// Start
// ------------------------------------------
// Fill static icons: <span data-icon="mail"></span>
$all("[data-icon]").forEach((el) => {
  const make = AF_ICONS[el.dataset.icon];
  if (make) el.outerHTML = make(Number(el.dataset.size) || 16);
});
checkBackend();
showTab(location.hash.slice(1) || "applications");
