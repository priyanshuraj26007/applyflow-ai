// ==========================================
// APPLYFLOW AI — REVIEW & APPLY PAGE
// ==========================================
// Flow: load application → (prepare: match resumes + draft email) → user edits
//       → user clicks Send → confirm dialog → backend sends via Gmail.
const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const appId = new URLSearchParams(location.search).get("id");

// Fill static icons: <span data-icon="attach"></span>
$all("[data-icon]").forEach((el) => {
  const make = AF_ICONS[el.dataset.icon];
  if (make) el.outerHTML = make(Number(el.dataset.size) || 16);
});
let app = null;
let resumes = [];
let gmail = { configured: false, connected: false };
let statuses = [];
let busy = false;
let dirty = false;      // user edited the email since it was generated

// ------------------------------------------
// Loading + banners
// ------------------------------------------
function setLoading(title, text) {
  $("#loading").classList.toggle("hidden", !title);
  if (title) {
    $("#loadingTitle").textContent = title;
    $("#loadingText").textContent = text || "";
  }
}

function banner(html, type = "warn", id) {
  if (id) $(`#banner-${id}`)?.remove();
  const div = document.createElement("div");
  div.className = `banner ${type}`;
  if (id) div.id = `banner-${id}`;
  div.innerHTML = html;
  $("#banners").appendChild(div);
  return div;
}
function clearBanner(id) { $(`#banner-${id}`)?.remove(); }

function setComposerEnabled(enabled) {
  const sent = app?.status === "Applied" && app?.sentMessageId;
  for (const el of $all("#emailTo, #emailSubject, #emailBody, #regenBtn, #rematchBtn")) {
    el.disabled = !enabled || sent;
  }
  $("#sendBtn").disabled = !enabled || !app?.email?.body;
  $all("#matchList input").forEach(i => { i.disabled = !enabled || sent; });
}

// ------------------------------------------
// Rendering
// ------------------------------------------
function renderJob() {
  const job = app.job || {};
  document.title = `${job.jobTitle || "Application"} · ApplyFlow AI`;
  $("#jobTitle").textContent = job.jobTitle || "Untitled role";
  $("#jobCompany").textContent = [job.company, job.location].filter(Boolean).join(" · ") || "Company not identified";

  $("#sourceBadge").innerHTML = app.analysisSource === "gemini"
    ? `<span class="badge">${AF_ICONS.sparkle(12)}Analysed by AI</span>`
    : `<span class="badge warn">Local extraction (AI unavailable)</span>`;

  const rows = [
    ["Recruiter", job.recruiter],
    ["Recruiter email", job.email],
    ["Experience", job.experience],
    ["Location", job.location],
    ["Joining", job.joining],
    ["Deadline", job.deadline],
    ["Category", job.category],
    ["How to apply", job.applicationInstructions]
  ].filter(([, v]) => v);
  $("#jobDetails").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") ||
    `<dt>Details</dt><dd class="muted">No details extracted</dd>`;

  const skills = job.skills || [];
  $("#jobSkillsWrap").classList.toggle("hidden", !skills.length);
  $("#jobSkills").innerHTML = skills.map(s => `<span class="chip">${esc(s)}</span>`).join("");

  $("#postText").textContent = app.postText || "";
  if (app.sourceUrl) {
    $("#postLink").href = app.sourceUrl;
    $("#postLink").classList.remove("hidden");
  }

  $("#statusBadge").innerHTML = statusBadge(app.status);
}

function resumeLabel(id) {
  const r = resumes.find(x => x.id === id);
  return r ? r.label : "Deleted resume";
}

function renderMatches() {
  const list = $("#matchList");
  const rankings = app.match?.rankings || [];
  if (!rankings.length) {
    list.innerHTML = `<div class="muted small">No match yet.</div>`;
    return;
  }
  $("#matchModel").textContent = app.match?.model ? `· ${app.match.model}` : "";

  list.innerHTML = rankings.map((r, i) => {
    const selected = r.resumeId === app.resumeId;
    return `
      <label class="match ${selected ? "selected" : ""}">
        <div class="match-head">
          <input type="radio" name="resume" value="${esc(r.resumeId)}" ${selected ? "checked" : ""}>
          <span class="match-name">${esc(resumeLabel(r.resumeId))}
            ${i === 0 ? `<span class="badge solid" style="margin-left:6px">Best match</span>` : ""}
            ${selected && r.resumeId !== app.match.recommendedResumeId ? `<span class="badge" style="margin-left:6px">Your choice</span>` : ""}
          </span>
          <span class="score" style="color:${scoreColor(r.score)}">${r.score}</span>
        </div>
        <div class="score-bar"><div style="width:${r.score}%;background:${scoreColor(r.score)}"></div></div>
        ${r.reasons.length ? `<ul>${r.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${r.relevantHighlights.length ? `<div class="sub">Relevant experience</div><ul>${r.relevantHighlights.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${r.missingSkills.length ? `<div class="sub">Gaps</div><div class="chips" style="margin-top:4px">${r.missingSkills.map(x => `<span class="chip missing">${esc(x)}</span>`).join("")}</div>` : ""}
      </label>`;
  }).join("");
}

function renderEmail() {
  const email = app.email || {};
  $("#emailTo").value = email.to || app.job?.email || "";
  $("#emailSubject").value = email.subject || "";
  $("#emailBody").value = email.body || "";
  $("#toHint").classList.toggle("hidden", !!$("#emailTo").value);

  const resumeId = app.resumeId;
  $("#attachName").textContent = resumeId ? (resumes.find(r => r.id === resumeId)?.originalName || resumeLabel(resumeId)) : "No resume selected";
  $("#attachView").href = "#";
  $("#attachView").onclick = (e) => { e.preventDefault(); if (resumeId) openResumePdf(resumeId); };
  dirty = false;
  $("#saveState").textContent = email.generatedWith ? `Drafted by ${email.generatedWith}` : "";
  if (email.eligibility && !app.sentMessageId) {
    banner(`${AF_ICONS.warning(16)}<span><strong>Check before sending:</strong> ${esc(email.eligibility)}</span>`, "warn", "eligibility");
  } else {
    clearBanner("eligibility");
  }
}

function renderGmail() {
  const line = $("#gmailLine");
  if (!gmail.configured) {
    line.innerHTML = `${AF_ICONS.warning(15)}<span>Gmail sending isn't switched on yet. Use “Copy text” to send it yourself.</span>`;
  } else if (!gmail.connected) {
    line.innerHTML = `${AF_ICONS.mail(15)}<span class="spacer">Connect Gmail to send directly.</span><button class="btn small primary" id="connectGmail">Connect Gmail</button>`;
    $("#connectGmail").onclick = connectGmail;
  } else {
    line.innerHTML = `<span class="badge ok"><span class="dot"></span>Gmail</span><span>Sending from <strong>${esc(gmail.email || "your Gmail")}</strong></span>`;
  }
}

function renderTracking() {
  $("#statusSelect").innerHTML = statuses.map(s => `<option ${s === app.status ? "selected" : ""}>${esc(s)}</option>`).join("");
  if (document.activeElement !== $("#notes")) $("#notes").value = app.notes || "";
  $("#markAppliedBtn").classList.toggle("hidden", !!app.appliedAt);
  $("#history").innerHTML = (app.history || []).slice().reverse().slice(0, 8)
    .map(h => `<div>${esc(formatDate(h.at, true))} — ${esc(h.event)}</div>`).join("");
}

function renderSentState() {
  if (!(app.status === "Applied" || app.appliedAt) || !app.sentMessageId) return;
  clearBanner("dup");
  banner(`${AF_ICONS.check(16)}<span>Application sent to <strong>${esc(app.email?.to)}</strong> on ${esc(formatDate(app.appliedAt, true))}.</span>`, "ok", "sent");
  $("#sendBtn").textContent = "Sent";
  $("#sendBtn").disabled = true;
}

function renderAll() {
  renderJob();
  renderMatches();
  renderEmail();
  renderGmail();
  renderTracking();
  setComposerEnabled(!busy);
  renderSentState();
}

// ------------------------------------------
// Actions
// ------------------------------------------
async function prepare(options = {}) {
  busy = true;
  setComposerEnabled(false);
  clearBanner("prepare");
  setLoading(
    options.resumeId ? "Rewriting the email for your chosen resume…" : "Matching your resumes and drafting a personalised email…",
    "This usually takes a few seconds."
  );
  try {
    const data = await api(`/api/applications/${encodeURIComponent(appId)}/prepare`, {
      method: "POST", body: options, timeout: 150000
    });
    app = data.application;
    showDuplicates(data.duplicates);
  } catch (error) {
    if (error.code === "NO_AI_KEY") {
      banner(`${esc(error.message)} <a href="dashboard.html#settings" target="_blank">Open Settings →</a>
              <button class="btn small" id="retryPrepare" style="margin-left:8px">I've added it — retry</button>`, "warn", "prepare");
    } else if (error.code === "NO_RESUMES") {
      banner(`${esc(error.message)} <a href="dashboard.html#resumes" target="_blank">Open the resume library →</a>
              <button class="btn small" id="retryPrepare" style="margin-left:8px">I've uploaded one — retry</button>`, "warn", "prepare");
    } else {
      banner(`Couldn't prepare the application: ${esc(error.message)}
              <button class="btn small" id="retryPrepare" style="margin-left:8px">Try again</button>`, "danger", "prepare");
    }
    $("#retryPrepare").onclick = () => prepare(options);
  } finally {
    busy = false;
    setLoading(null);
    $("#layout").classList.remove("hidden");
    renderAll();
  }
}

function showDuplicates(duplicates = []) {
  const earlier = duplicates.filter(d => d.appliedAt);
  if (earlier.length && !app.sentMessageId) {
    banner(`You already applied to what looks like the same opening on ${esc(formatDate(earlier[0].appliedAt))}
            (${esc(earlier[0].jobTitle || "")}${earlier[0].company ? " at " + esc(earlier[0].company) : ""}).`, "info", "dup");
  }
}

let saveTimer;
function scheduleSave() {
  dirty = true;
  $("#saveState").textContent = "Editing…";
  $("#toHint").classList.toggle("hidden", !!$("#emailTo").value.trim());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/applications/${encodeURIComponent(appId)}`, {
        method: "PATCH",
        body: { email: { to: $("#emailTo").value, subject: $("#emailSubject").value, body: $("#emailBody").value } }
      });
      app.email = data.application.email;
      $("#saveState").textContent = "Draft saved";
    } catch (error) {
      $("#saveState").textContent = "Not saved — " + error.message;
    }
  }, 800);
}

async function onResumeChange(resumeId) {
  if (resumeId === app.resumeId) return;
  if (dirty && !(await confirmDialog({
    title: "Switch resume?",
    html: "The email will be rewritten for this resume and your manual edits will be replaced.",
    confirmText: "Switch & rewrite"
  }))) {
    renderMatches();
    return;
  }
  await prepare({ resumeId });
}

async function send(allowDuplicate = false) {
  const to = $("#emailTo").value.trim();
  const subject = $("#emailSubject").value.trim();
  const body = $("#emailBody").value.trim();

  if (!EMAIL_RE.test(to)) { toast("Please enter a valid recruiter email address.", "error"); $("#emailTo").focus(); return; }
  if (!subject) { toast("Please add a subject.", "error"); return; }
  if (!body) { toast("The email body is empty.", "error"); return; }
  if (!app.resumeId) { toast("Please choose a resume to attach.", "error"); return; }
  if (!gmail.connected) {
    toast(gmail.configured ? "Connect Gmail first (button above the email)." : "Gmail isn't set up yet — see Settings in the dashboard.", "error");
    return;
  }

  if (!allowDuplicate) {
    const ok = await confirmDialog({
      title: "Send this application?",
      html: `<dl class="kv">
               <dt>To</dt><dd>${esc(to)}</dd>
               <dt>From</dt><dd>${esc(gmail.email || "your Gmail")}</dd>
               <dt>Subject</dt><dd>${esc(subject)}</dd>
               <dt>Attachment</dt><dd>${esc($("#attachName").textContent)}</dd>
             </dl>
             <p class="muted small" style="margin-bottom:0">The email will be sent immediately from your Gmail account.</p>`,
      confirmText: "Send now"
    });
    if (!ok) return;
  }

  busy = true;
  setComposerEnabled(false);
  $("#sendBtn").innerHTML = `<span class="spinner"></span> Sending…`;
  try {
    clearTimeout(saveTimer);
    const data = await api(`/api/applications/${encodeURIComponent(appId)}/send`, {
      method: "POST",
      body: { to, subject, body, resumeId: app.resumeId, confirm: true, allowDuplicate },
      timeout: 60000
    });
    app = data.application;
    toast("Application sent! 🎉");
  } catch (error) {
    if (error.code === "DUPLICATE") {
      busy = false;
      $("#sendBtn").textContent = "Send Application";
      const again = await confirmDialog({
        title: "Already applied",
        html: `${esc(error.message)}`,
        confirmText: "Send again anyway"
      });
      if (again) { await send(true); return; }
    } else {
      if (error.code === "GMAIL_RECONNECT" || error.code === "GMAIL_NOT_CONNECTED") {
        gmail.connected = false;
        renderGmail();
      }
      toast(error.message, "error");
    }
  } finally {
    busy = false;
    $("#sendBtn").textContent = "Send Application";
    renderAll();
  }
}

async function patchApp(changes) {
  try {
    const data = await api(`/api/applications/${encodeURIComponent(appId)}`, { method: "PATCH", body: changes });
    app = { ...app, ...data.application };
    renderJob();
    renderTracking();
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

async function refreshGmail() {
  try {
    gmail = await api("/api/gmail/status");
    renderGmail();
  } catch { /* backend offline is reported elsewhere */ }
}

// ------------------------------------------
// Wire up events
// ------------------------------------------
$("#emailTo").addEventListener("input", scheduleSave);
$("#emailSubject").addEventListener("input", scheduleSave);
$("#emailBody").addEventListener("input", scheduleSave);
$("#matchList").addEventListener("change", (e) => {
  if (e.target.name === "resume") onResumeChange(e.target.value);
});
$("#regenBtn").addEventListener("click", async () => {
  if (dirty && !(await confirmDialog({ title: "Regenerate email?", html: "Your manual edits will be replaced.", confirmText: "Regenerate" }))) return;
  prepare({ regenerateEmail: true });
});
$("#rematchBtn").addEventListener("click", () => prepare({ rematch: true }));
$("#copyBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(`To: ${$("#emailTo").value}\nSubject: ${$("#emailSubject").value}\n\n${$("#emailBody").value}`);
  toast("Email copied to clipboard.");
});
$("#sendBtn").addEventListener("click", () => send(false));
$("#statusSelect").addEventListener("change", (e) => patchApp({ status: e.target.value }));
$("#markAppliedBtn").addEventListener("click", () => patchApp({ status: "Applied" }));
let notesTimer;
$("#notes").addEventListener("input", () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => patchApp({ notes: $("#notes").value }), 700);
});
// Coming back from the Google sign-in tab → refresh Gmail status.
window.addEventListener("focus", refreshGmail);

// ------------------------------------------
// Start
// ------------------------------------------
(async function init() {
  if (!appId) {
    setLoading(null);
    banner("No application selected. Open this page from the LinkedIn popup or the dashboard.", "danger");
    return;
  }
  try {
    const [appData, resumeData, gmailData] = await Promise.all([
      api(`/api/applications/${encodeURIComponent(appId)}`),
      api("/api/resumes"),
      api("/api/gmail/status").catch(() => ({ configured: false, connected: false }))
    ]);
    app = appData.application;
    statuses = appData.statuses;
    resumes = resumeData.resumes;
    gmail = gmailData;
    showDuplicates(appData.duplicates);

    if (app.sentMessageId || (app.email?.body && app.match)) {
      setLoading(null);
      $("#layout").classList.remove("hidden");
      renderAll();
    } else {
      $("#layout").classList.remove("hidden");
      renderAll();
      await prepare();
    }
  } catch (error) {
    setLoading(null);
    banner(esc(error.message), "danger");
  }
})();
