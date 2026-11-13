// ==========================================
// APPLYFLOW AI — TOOLBAR POPUP
// Status overview + dashboard shortcut + manual "import selected text".
// (The resume library moved to the Dashboard → Resumes tab.)
// ==========================================
const readButton = document.getElementById("readPost");
const analyzeButton = document.getElementById("analyzePost");
const jobDescription = document.getElementById("jobDescription");
const status = document.getElementById("status");
const extractedInfo = document.getElementById("extractedInfo");

let lastResult = null; // { applicationId, jobData } from the last analysis
let lastSourceUrl = null;

// ------------------------------------------
// Status panel
// ------------------------------------------
// Icons
$("#logo").innerHTML = AF_ICONS.logo(36);
$("#docIcon").innerHTML = AF_ICONS.doc(16);
$("#chevIcon").innerHTML = AF_ICONS.chevronRight(14);

async function loadStatus() {
  try {
    const s = await api("/api/status", { timeout: 12000 }); // the server may need a few seconds to wake up
    $("#liveBadge").className = "badge ok";
    $("#liveText").textContent = "Live";
    $("#stKey").textContent = s.aiKeys?.groq || s.aiKeys?.gemini ? "Added" : "Not added: open Settings";
    $("#stGmail").textContent = s.gmail.connected ? "Connected" : (s.gmail.configured ? "Not connected" : "Not set up");
    $("#stResumes").textContent = s.resumes
      ? (s.analysedResumes === s.resumes ? `${s.resumes} ready` : `${s.analysedResumes} of ${s.resumes} ready`)
      : "None yet";
    $("#stApps").textContent = `${s.applications} found · ${s.applied} sent`;
  } catch (error) {
    $("#liveBadge").className = "badge danger";
    $("#liveText").textContent = "Offline";
    $("#offline").classList.remove("hidden");
  }
}

$("#openDashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

// ------------------------------------------
// Import selected text from the active webpage (original feature, kept)
// ------------------------------------------
readButton.addEventListener("click", async () => {

  try {

    status.textContent = "Reading selected job post...";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },

      func: () => window.getSelection().toString()
    });

    const selectedText = results[0].result;

    if (!selectedText || !selectedText.trim()) {

      status.textContent = "Please select a job post first.";
      return;

    }

    jobDescription.value = selectedText;
    lastSourceUrl = tab.url || null;

    extractedInfo.classList.add("hidden");

    status.textContent = "Job post imported successfully!";

  } catch (error) {

    console.error(error);
    status.textContent = "Unable to read this webpage.";

  }

});

// ------------------------------------------
// Analyse with Gemini (via the background worker → backend)
// ------------------------------------------
analyzeButton.addEventListener("click", async () => {

  const text = jobDescription.value;

  if (text.trim().length < 30) {
    status.textContent = "Please import or paste a longer job post.";
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.innerHTML = `<span class="spinner"></span> Analysing…`;
  status.textContent = "";
  extractedInfo.classList.add("hidden");

  const result = await chrome.runtime.sendMessage({
    type: "ANALYZE_TEXT",
    postText: text,
    sourceUrl: lastSourceUrl
  }).catch(error => ({ success: false, error: error.message }));

  analyzeButton.disabled = false;
  analyzeButton.textContent = "Analyse with AI";

  if (!result?.success) {
    status.textContent = result?.error || "Analysis failed.";
    return;
  }

  lastResult = result;
  const job = result.jobData;

  if (!job.isHiringPost) {
    status.textContent = "The AI doesn't think this is a hiring post.";
  } else {
    status.textContent = "Job analysis completed! Please verify the details.";
  }

  $("#resTitle").textContent = job.jobTitle || "Untitled role";
  const rows = [
    ["Company", job.company], ["Recruiter", job.recruiter], ["Email", job.email],
    ["Experience", job.experience], ["Location", job.location], ["Category", job.category],
    ["Skills", (job.skills || []).join(", ")]
  ].filter(([, v]) => v);
  $("#resDetails").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#reviewBtn").classList.toggle("hidden", !result.applicationId);
  extractedInfo.classList.remove("hidden");
});

$("#reviewBtn").addEventListener("click", () => {
  if (!lastResult?.applicationId) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(lastResult.applicationId)}`) });
  window.close();
});

loadStatus();

// Show the real version from manifest.json.
try { document.getElementById("version").textContent = `Version ${chrome.runtime.getManifest().version}`; } catch { /* outside Chrome */ }
