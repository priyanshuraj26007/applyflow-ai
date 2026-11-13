
console.log("ApplyFlow AI: LinkedIn detector activated!");

// ==========================================
// APPLYFLOW AI - LINKEDIN HIRING POST DETECTION
// ==========================================

const processedPosts = new WeakSet();   // DOM containers already handled
const processedKeys = new Set();        // post text fingerprints (survives LinkedIn re-rendering)
const unplacedTexts = new Set();        // hiring text we couldn't attach to a post (logged once)

// Pages where we never scan (V1 focuses on feed hiring posts, not LinkedIn Jobs).
const SKIPPED_PATHS = /^\/(jobs|messaging|notifications|mynetwork|learning|premium|search\/results\/(jobs|people))/;

const hiringKeywords = [
  "we are hiring",
  "we're hiring",
  "hiring now",
  "now hiring",
  "#hiring",
  "job opening",
  "openings for",
  "open position",
  "looking for candidates",
  "looking to hire",
  "send your resume",
  "share your resume",
  "share your cv",
  "send your cv",
  "share resume",
  "send resume",
  "resumes at",
  "cv at",
  "cv to",
  "resume to",
  "interested candidates",
  "join our team",
  "immediate hiring",
  "immediate joiners",
  "we are looking for",
  "we're looking for",
  "vacancy",
  "walk-in"
];

// Newer LinkedIn layouts expose these on each feed update.
const POST_SELECTORS = [
  "[data-urn^='urn:li:activity']",
  "[data-id^='urn:li:activity']",
  "[data-urn^='urn:li:share']",
  "div.feed-shared-update-v2",
  "[data-view-name='feed-full-update']",
  "div[role='article']"
].join(",");

// Every post has exactly one "Repost" button in its action bar (comments don't),
// so it's a layout-independent way to find where a post starts and ends.
function repostButtonCount(el) {
  let n = 0;
  for (const b of el.querySelectorAll("button, [role='button']")) {
    const label = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`;
    if (/\brepost\b/i.test(label)) n++;
    if (n > 1) break;
  }
  return n;
}

function findHiringPostContainer(element) {
  // 1. Prefer LinkedIn's own post markers when present (and they wrap just one post).
  const marked = element.closest(POST_SELECTORS);
  if (marked) {
    const len = (marked.innerText || "").length;
    if (len > 80 && len < 15000 && repostButtonCount(marked) <= 1) return marked;
  }

  // 2. Layout-independent: the nearest ancestor that holds ONE post action bar.
  let node = element.parentElement;
  for (let level = 0; level < 25 && node && node !== document.body; level++) {
    const count = repostButtonCount(node);
    if (count > 1) break;                       // climbed past the post into the feed
    if (count === 1) {
      const len = (node.innerText || "").length;
      if (len > 30 && len < 20000) return node;
      break;
    }
    node = node.parentElement;
  }

  // 3. Fallback: the original heuristic that worked on the user's interface.
  let current = element;

  for (let level = 0; level < 10 && current; level++) {
    const text = current.innerText || "";

    // LinkedIn feed post containers often include this label.
    if (
      current.tagName === "DIV" &&
      text.includes("Feed post") &&
      text.length > 200 &&
      text.length < 15000
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function normaliseForMatch(text) {
  return text.toLowerCase().replace(/[’‘`]/g, "'");
}

function looksLikeHiringPost(text) {
  const t = normaliseForMatch(text);
  if (hiringKeywords.some(keyword => t.includes(keyword))) return true;

  // Posts without obvious keywords but with an email + application words.
  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t);
  return hasEmail && /\b(resume|cv|apply|applications?|candidates?|opening|role|position)\b/.test(t);
}

// Fingerprint of a post's text, so the same post is recognised after re-rendering.
function postKeyFor(text) {
  const normalised = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\d+\s*(?:[smhdw]|mo|yr)\b/g, "")
    .replace(/[^a-z0-9@.]+/g, " ")
    .trim()
    .slice(0, 3000);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < normalised.length; i++) {
    const c = normalised.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 31) ^ c;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + normalised.length.toString(36);
}

// Remove LinkedIn UI chrome (buttons, counters) from the copied post text.
function cleanPostText(raw) {
  const junk = /^(feed post|like|comment|repost|send|follow|\+ follow|following|…?\s*(see )?more|show translation|reply|load more comments|\d+ (comments?|reposts?|reactions?)|\d+)$/i;
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !junk.test(line))
    .join("\n")
    .substring(0, 10000);
}

function sourceUrlFor(container) {
  const urnHolder = container.closest("[data-urn],[data-id]") || container.querySelector("[data-urn^='urn:li:'],[data-id^='urn:li:']");
  const urn = urnHolder?.getAttribute("data-urn") || urnHolder?.getAttribute("data-id") || "";
  if (/^urn:li:(activity|share|ugcPost):\d+$/.test(urn)) {
    return `https://www.linkedin.com/feed/update/${urn}/`;
  }
  return location.pathname.startsWith("/posts/") ? location.href.split("?")[0] : null;
}

function detectHiringPosts() {
  if (SKIPPED_PATHS.test(location.pathname)) return;

  const textElements = document.querySelectorAll("span, p");

  textElements.forEach((element) => {
    // Cheap pre-check before reading layout-dependent innerText.
    const raw = element.textContent || "";
    if (raw.length < 12) return;

    if (!looksLikeHiringPost(raw)) return;

    const postContainer = findHiringPostContainer(element);

    if (!postContainer) {
      // Hiring words found but not the post around them — log once so misses can be diagnosed.
      const key = raw.slice(0, 80);
      if (!unplacedTexts.has(key)) {
        unplacedTexts.add(key);
        console.warn("ApplyFlow AI: hiring text found, but couldn't locate its post on the page:", key);
      }
      return;
    }
    if (processedPosts.has(postContainer)) {
      return;
    }

    processedPosts.add(postContainer);

    const postText = cleanPostText(postContainer.innerText.trim());
    if (postText.length < 30) return;

    const postId = postKeyFor(postText);
    if (processedKeys.has(postId)) return;
    processedKeys.add(postId);

    console.log("ApplyFlow AI: Hiring post detected!");

    // Instant card from local text matching — the AI only runs when the user opens it.
    const sourceUrl = sourceUrlFor(postContainer);
    applyFlowPopup.addPost({ postId, postText, sourceUrl, element: postContainer });
  });
}



// ==========================================
// APPLYFLOW AI - JOB INFORMATION EXTRACTION
// ==========================================
// Local (regex) extraction — used instantly while Gemini works,
// and as a fallback if Gemini is unavailable.

function extractJobInformation(postText) {

  // Preserve line breaks instead of flattening the post.
  const lines = postText
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const text = lines.join("\n");

  // Find the actual hiring announcement.
  const headingIndex = lines.findIndex(line =>
    /we['']re hiring|we are hiring/i.test(line)
  );

  const jobLines = headingIndex >= 0
    ? lines.slice(headingIndex)
    : lines;

  const heading = headingIndex >= 0
    ? lines[headingIndex]
    : "";

  // Extract title and company from the hiring heading.
  const headingParts = heading
    .split("|")
    .map(part => part.trim());

  const headingTitle = headingParts.length >= 2
    ? headingParts[1].replace(/[🚀📍📢📌]/g, "").trim()
    : "";

  const headingCompany = headingParts.length >= 3
    ? headingParts[2].trim()
    : "";

  // Helper: extract a labelled field without swallowing later sections.
  function getField(label) {
    const line = jobLines.find(line =>
      new RegExp("^.*\\b" + label + "\\s*:", "i").test(line)
    );

    if (!line) return "Not specified";

    const match = line.match(
      new RegExp(label + "\\s*:\\s*([^:]+?)(?=\\s+(?:⚡|📍|📌|Preference|Key Responsibilities|What We're Looking For)|$)", "i")
    );

    return match ? match[1].trim() : "Not specified";
  }

  // 1. Job title.
  const position = getField("Position");

  const jobTitle = position !== "Not specified"
    ? position.replace(/[🚀📍📢📌]/g, "").trim()
    : headingTitle || "Hiring opportunity";

  // 2. Company: extract directly from the hiring headline.
const companyMatch = text.match(
  /we['’]re hiring\s*\|\s*[^|\n]+\s*\|\s*([^\n|]+)/i
);

const companyName = companyMatch
  ? companyMatch[1].trim()
  : headingCompany || "Not identified";

  // 3. Recruiter email.
  const emailMatch = text.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );

  const recruiterEmail = emailMatch
    ? emailMatch[0]
    : "Not found";

  // 4. Recruiter name.
  const recruiterMatch = text.match(
    /Feed post\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/
  );

  const recruiterName = recruiterMatch
    ? recruiterMatch[1].trim()
    : "Not identified";

  // 5. Other job details.
  const experience = getField("Experience");
  const location = getField("Location");
  const joining = getField("Joining");

  // 6. Skills.
  const skillList = [
    "Product Management",
    "Product Strategy",
    "Roadmap",
    "Stakeholder Management",
    "SQL",
    "Excel",
    "Python",
    "Power BI",
    "Tableau",
    "Machine Learning",
    "Data Analysis",
    "Analytics",
    "Problem-solving",
    "Decision-making",
    "Communication",
    "Market Research",
    "Project Management",
    "Java",
    "JavaScript",
    "React"
  ];

  const lowerText = jobLines.join(" ").toLowerCase();

  const skills = skillList.filter(skill =>
    lowerText.includes(skill.toLowerCase())
  );

  // 7. Category.
  let category = "General";

  if (/product manager|product management/i.test(jobTitle)) {
    category = "Product";
  } else if (/business analyst|data analyst/i.test(jobTitle)) {
    category = "Analyst";
  } else if (/operations|supply chain/i.test(jobTitle)) {
    category = "Operations";
  } else if (/consultant|consulting/i.test(jobTitle)) {
    category = "Consulting";
  } else if (/software engineer|developer|sde/i.test(jobTitle)) {
    category = "Software Engineering";
  } else if (/mechanical|electrical|civil|core engineer/i.test(jobTitle)) {
    category = "Core Engineering";
  }

  return {
    jobTitle,
    companyName,
    recruiterName,
    recruiterEmail,
    experience,
    location,
    joining,
    skills,
    category
  };
}

// Convert local extraction into the backend's job format (null = unknown).
function localJobForBackend(localJob) {
  const clean = (v) => (!v || /^(not specified|not identified|not found|hiring opportunity)$/i.test(v) ? null : v);
  return {
    jobTitle: clean(localJob.jobTitle),
    company: clean(localJob.companyName),
    recruiter: clean(localJob.recruiterName),
    email: clean(localJob.recruiterEmail),
    experience: clean(localJob.experience),
    location: clean(localJob.location),
    joining: clean(localJob.joining),
    category: localJob.category === "General" ? "Other" : localJob.category,
    skills: localJob.skills || [],
    applicationInstructions: null
  };
}

// Convert Gemini's job format into the popup's display format.
function displayJobFromAi(aiJob, localJob) {
  return {
    jobTitle: aiJob.jobTitle || "Not identified",
    companyName: aiJob.company || "Not identified",
    recruiterName: aiJob.recruiter || "Not identified",
    recruiterEmail: aiJob.email || "Not found",
    experience: aiJob.experience || "Not specified",
    location: aiJob.location || "Not specified",
    joining: aiJob.joining || "Not specified",
    category: aiJob.category || localJob.category || "General",
    skills: Array.isArray(aiJob.skills) ? aiJob.skills : [],
    applicationInstructions: aiJob.applicationInstructions || "Not specified",
    deadline: aiJob.deadline || null,
    experienceLevel: aiJob.experienceLevel || null,
    employmentType: aiJob.employmentType || null,
    requirements: Array.isArray(aiJob.requirements) ? aiJob.requirements : []
  };
}





// ==========================================
// APPLYFLOW AI - NOTIFICATION + FLOATING WINDOW (v2.2)
// ==========================================
// 1. A frosted notification drops in at the top right: "Hiring post detected".
// 2. Click it → the card expands into a floating window and the AI reads the post:
//    a job summary (company, role, fresher/experienced, skills, requirements).
// 3. "Generate application" → resume match + editable email → Send → Confirm.
//    Posts that are only scrolled past never use the AI (saves quota).
// 4. Drag the window by its header; it remembers where you left it.
//    Double-click the header to snap it back to the corner.
// 5. The window shrinks back to the notification when you scroll the feed, click
//    anywhere outside it, or press Escape. Nothing is lost: reopen it any time.
// 6. The notification always shows the NEWEST hiring post; ‹ › step back through older ones.
// 7. "Send later" (clock button next to Send): pick a time; the server sends it then,
//    even if this laptop is off. Until then the email stays editable, and it can be
//    sent now, moved to another time, or cancelled. Time helpers: schedule-time.js.
// 8. Always in sync with the dashboard / review page: the window reloads the latest
//    version when it opens, when you switch posts, and when you come back to this tab.
//    Every save/send/schedule says which version it was based on; if the application
//    was changed elsewhere meanwhile, the server refuses (STALE) and we reload.
// Everything lives in one Shadow DOM so LinkedIn's CSS can't break it.
// Light/dark follows LinkedIn's own theme. Icons come from icons.js (AF_ICONS).
// This page never talks to the backend directly — every call goes through background.js.

const CONFIRM_WINDOW_MS = 6000;
const EMAIL_PATTERN = /^[^\s@<>(),;:"\[\]\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const DEFAULT_POSITION = { right: 20, top: 64 }; // just below LinkedIn's top bar

// Load the bundled Inter font. (Chrome ignores @font-face inside a Shadow DOM,
// so the font is registered on the page; if anything fails we fall back to system fonts.)
(async function loadApplyFlowFont() {
  try {
    const url = chrome.runtime.getURL("fonts/Inter-Variable.woff2");
    const data = await (await fetch(url)).arrayBuffer();
    const face = new FontFace("ApplyFlow Inter", data, { weight: "100 900", style: "normal" });
    await face.load();
    document.fonts.add(face);
  } catch {
    // Font is cosmetic only.
  }
})();

// Promise wrapper around chrome.runtime.sendMessage that never throws and never hangs.
// If ApplyFlow was reloaded/updated while this LinkedIn tab stayed open, this tab's copy
// can't reach the extension any more: we say so (refresh the page) instead of waiting forever.
const MESSAGE_TIMEOUT_MS = 80000; // background.js gives up on the server after 65s
function sendToBackground(message) {
  const reloaded = {
    success: false,
    errorCode: "EXTENSION_RELOADED",
    error: "ApplyFlow was updated. Please refresh this LinkedIn page (press F5)."
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      success: false,
      errorCode: "NO_REPLY",
      error: "ApplyFlow didn't get an answer. Try again, or refresh this LinkedIn page."
    }), MESSAGE_TIMEOUT_MS);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    try {
      if (!chrome.runtime?.id) return done(reloaded);   // this tab's copy is orphaned
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) done(reloaded);
        else done(response || { success: false, error: "No response from ApplyFlow AI." });
      });
    } catch {
      done(reloaded);
    }
  });
}

// Is LinkedIn currently in dark mode? (Checks LinkedIn's theme class, then the
// actual page background, then the system setting.)
function pageIsDark() {
  const html = document.documentElement;
  if (/\btheme--dark\b|\bdark\b/i.test(html.className) || html.dataset.theme === "dark") return true;
  for (const el of [document.body, html]) {
    const bg = el && getComputedStyle(el).backgroundColor;
    const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
      const luminance = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      return luminance < 0.45;
    }
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

const applyFlowPopup = (() => {
  const posts = [];
  let index = -1;
  let host = null;
  let root = null;
  let mode = "hidden";        // "toast" | "panel" | "hidden"
  let userBrowsing = false;   // user used ‹ › — don't jump to newer posts
  let context = null;         // { resumes, gmail } from the backend
  let tickTimer = null;
  let saveTimer = null;
  let confirmTimer = null;
  let position = { ...DEFAULT_POSITION };
  let justOpened = false;     // play the expand animation only once per open
  let toastAnimated = false;  // the notification drops in once, not on every update
  let scrollAnchor = 0;       // page scroll position when the window was opened
  let ignoreScrollUntil = 0;  // our own "View post" scrolling shouldn't close the window

  // Restore the position the user dragged the window to last time.
  try {
    chrome.storage.local.get("afWindowPosition", (stored) => {
      if (stored?.afWindowPosition) position = clampPosition(stored.afWindowPosition);
      if (host) applyPosition();
    });
  } catch { /* storage is optional */ }

  // ---------- Setup ----------
  function ensureHost() {
    if (host && document.body.contains(host)) return;
    host = document.createElement("div");
    host.id = "applyflow-floating-popup";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${POPUP_CSS}</style><div class="layer"></div>`;
    document.body.appendChild(host);

    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-drag]") && !e.target.closest("button")) {
        position = { ...DEFAULT_POSITION };
        savePosition();
        applyPosition();
      }
    });
    // Keep typing inside our fields from triggering LinkedIn keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      root.addEventListener(type, (e) => {
        if (type === "keydown" && e.key === "Escape" && mode === "panel") closePanel();
        e.stopPropagation();
      });
    }
    window.addEventListener("resize", () => { position = clampPosition(position); applyPosition(); });
  }

  const current = () => posts[index];

  function newPostState({ postId, postText, sourceUrl, element }) {
    const localJob = extractJobInformation(postText);
    return {
      postId, postText, sourceUrl, element,
      state: "detected",            // detected | analysing | ai | fallback
      startedAt: Date.now(),
      notHiring: false,             // the AI says this isn't a job opening
      localJob,
      job: localJob,
      aiJob: null,
      applicationId: null,
      alreadyApplied: false,
      error: null,
      draft: { status: "idle" },    // idle | loading | ready | error
      application: null,
      duplicates: [],
      fields: { to: "", subject: "", body: "" },
      resumeId: null,
      edited: false,
      saveNote: "",
      send: { status: "idle" }      // idle | confirm | sending | duplicate | sent
    };
  }

  // ---------- Public API used by the detector / message listener ----------
  function addPost(info) {
    const post = newPostState(info);
    posts.push(post);

    if (mode === "panel") {
      render(); // just refreshes the "1 of N" counter — don't switch posts under the user
      return;
    }
    // The notification always shows the newest post; ‹ › go back to older ones.
    index = posts.length - 1;
    userBrowsing = false;
    mode = "toast";
    render();
  }

  function update(postId, changes) {
    const post = posts.find(p => p.postId === postId);
    if (!post) return;
    Object.assign(post, changes);
    render();
  }

  function removePost(postId) {
    const i = posts.findIndex(p => p.postId === postId);
    if (i === -1) return;
    posts.splice(i, 1);
    if (index >= posts.length) index = posts.length - 1;
    if (!posts.length) mode = "hidden";
    render();
  }

  // ---------- Window position + dragging ----------
  function clampPosition(p) {
    const width = mode === "panel" ? 420 : 380;
    const maxRight = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 120);
    return {
      right: Math.min(Math.max(8, Number(p.right) || DEFAULT_POSITION.right), maxRight),
      top: Math.min(Math.max(8, Number(p.top) || DEFAULT_POSITION.top), maxTop)
    };
  }

  function applyPosition() {
    const el = root?.querySelector(".toast, .window");
    if (!el) return;
    el.style.right = `${position.right}px`;
    el.style.top = `${position.top}px`;
    if (el.classList.contains("window")) {
      el.style.maxHeight = `${Math.max(320, window.innerHeight - position.top - 16)}px`;
    }
  }

  function savePosition() {
    try { chrome.storage.local.set({ afWindowPosition: position }); } catch { /* optional */ }
  }

  function onPointerDown(event) {
    const handle = event.target.closest("[data-drag]");
    if (!handle || event.target.closest("button, input, textarea, a") || event.button !== 0) return;
    const el = root.querySelector(".window");
    if (!el) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...position };
    el.classList.add("dragging");

    const move = (e) => {
      position = clampPosition({ right: start.right - (e.clientX - startX), top: start.top + (e.clientY - startY) });
      applyPosition();
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      savePosition();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------- Window actions ----------
  function openPanel() {
    mode = "panel";
    justOpened = true;
    scrollAnchor = window.scrollY;
    const post = current();
    position = clampPosition(position);
    render();
    loadContext();
    if (post) analysePost(post);
    if (post?.applicationId && post.draft.status !== "idle") refreshPost(post);
  }

  function closePanel() {
    flushSave();
    mode = posts.length ? "toast" : "hidden";
    render();
  }

  // ---------- Shrink back to the notification ----------
  // Scrolling the feed, clicking outside the window, or Escape → back to the notification.
  // (The post, the job summary and any email edits stay exactly as they were.)
  window.addEventListener("scroll", () => {
    if (mode !== "panel") return;
    if (Date.now() < ignoreScrollUntil) { scrollAnchor = window.scrollY; return; }
    if (Math.abs(window.scrollY - scrollAnchor) > 80) closePanel();
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    if (mode === "panel" && host && !event.composedPath().includes(host)) closePanel();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mode === "panel") closePanel();
  }, true);

  async function loadContext() {
    const response = await sendToBackground({ type: "GET_CONTEXT" });
    if (response.success) {
      context = { resumes: response.resumes, gmail: response.gmail };
      if (mode === "panel") render();
    }
  }

  // Step 1 (on open): the AI reads the post → job summary. Runs once per post.
  async function analysePost(post, { force = false } = {}) {
    if (post.state !== "detected") return;
    post.state = "analysing";
    post.startedAt = Date.now();
    post.error = null;
    const attempt = (post.attempt || 0) + 1;
    post.attempt = attempt;
    render();

    const response = await sendToBackground({
      type: "ANALYZE_POST", postId: post.postId, postText: post.postText, sourceUrl: post.sourceUrl, force
    });
    if (post.attempt !== attempt) return; // the user pressed "Try again" meanwhile
    if (response.success && response.jobData) {
      post.aiJob = response.jobData;
      post.job = displayJobFromAi(response.jobData, post.localJob);
      post.applicationId = response.applicationId || post.applicationId;
      post.alreadyApplied = !!response.alreadyApplied;
      post.notHiring = response.jobData.isHiringPost === false;
      post.state = "ai";
    } else {
      post.state = "fallback";
      post.error = response.error || "The AI couldn't read this post.";
    }
    render();
  }

  // Step 2 (on "Generate application"): resume match + email.
  async function startDraft(post, options = {}) {
    post.draft = { status: "loading", startedAt: Date.now() };
    post.send = { status: "idle" };
    render();

    const response = await sendToBackground({
      type: "PREPARE_DRAFT",
      applicationId: post.applicationId,
      postText: post.postText,
      sourceUrl: post.sourceUrl,
      localJob: localJobForBackend(post.localJob),
      resumeId: options.resumeId,
      regenerateEmail: options.regenerate
    });

    if (response.success) {
      const app = response.application;
      post.application = app;
      post.applicationId = app.id;
      post.baseUpdatedAt = app.updatedAt || null;
      post.resumeId = app.resumeId;
      post.duplicates = response.duplicates || [];
      post.fields = { to: app.email?.to || "", subject: app.email?.subject || "", body: app.email?.body || "" };
      post.edited = false;
      post.saveNote = "";
      if (app.job && app.analysisSource === "gemini") {
        // Keep summary fields from the earlier read if this record lacks them.
        post.aiJob = { ...(post.aiJob || {}), ...Object.fromEntries(Object.entries(app.job).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) };
        post.job = displayJobFromAi(post.aiJob, post.localJob);
      }
      post.draft = { status: "ready", seconds: ((Date.now() - post.draft.startedAt) / 1000).toFixed(1) };
      if (app.sentMessageId) post.send = { status: "sent" };
    } else {
      post.draft = { status: "error", error: response.error, errorCode: response.errorCode };
    }
    render();
  }

  function scheduleSave(post) {
    post.edited = true;
    post.saveNote = "Editing…";
    setFootNote(post.saveNote);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(post), 800);
  }

  function saveNow(post) {
    saveTimer = null;
    if (!post.applicationId) return Promise.resolve();
    // One save at a time, each based on the version the previous save returned.
    post.saving = Promise.resolve(post.saving).then(async () => {
      const response = await sendToBackground({
        type: "SAVE_DRAFT", applicationId: post.applicationId, email: { ...post.fields }, baseUpdatedAt: post.baseUpdatedAt
      });
      if (response.success) {
        post.application = response.application || post.application;
        post.baseUpdatedAt = response.application?.updatedAt || post.baseUpdatedAt;
        post.saveNote = "Draft saved";
      } else if (response.errorCode === "STALE") {
        return handleStale(post);
      } else {
        post.saveNote = `Not saved — ${response.error}`;
      }
      if (post === current()) setFootNote(post.saveNote);
    });
    return post.saving;
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      const post = current();
      if (post) saveNow(post);
    }
  }

  function validateBeforeSend(post) {
    if (!EMAIL_PATTERN.test(post.fields.to.trim())) return "Add a valid recruiter email in the To field.";
    if (!post.fields.subject.trim()) return "The subject is empty.";
    if (!post.fields.body.trim()) return "The message is empty.";
    if (!post.resumeId) return "Choose a resume to attach.";
    if (!context?.gmail?.connected) return "GMAIL";
    return null;
  }

  async function onSendClick(post) {
    if (!context) await loadContext(); // make sure we know the Gmail status
    const problem = validateBeforeSend(post);
    if (problem) {
      post.send = { status: "idle", error: problem };
      render();
      return;
    }
    post.send = { status: "confirm" };
    render();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      if (post.send.status === "confirm") {
        post.send = { status: "idle" };
        render();
      }
    }, CONFIRM_WINDOW_MS);
  }

  async function doSend(post, allowDuplicate = false) {
    clearTimeout(confirmTimer);
    clearTimeout(saveTimer);
    saveTimer = null;
    post.send = { status: "sending" };
    render();
    await post.saving;

    const response = await sendToBackground({
      type: "SEND_APPLICATION",
      baseUpdatedAt: post.baseUpdatedAt,
      applicationId: post.applicationId,
      to: post.fields.to.trim(),
      subject: post.fields.subject.trim(),
      body: post.fields.body,
      resumeId: post.resumeId,
      confirm: true,               // the user clicked Send and then Confirm
      allowDuplicate
    });

    if (response.success) {
      applyServerApplication(post, response.application);
      post.send = { status: "sent" };
      post.alreadyApplied = true;
    } else if (response.errorCode === "STALE") {
      return handleStale(post);
    } else if (response.errorCode === "DUPLICATE") {
      post.send = { status: "duplicate", error: response.error };
    } else {
      if (response.errorCode === "GMAIL_RECONNECT" || response.errorCode === "GMAIL_NOT_CONNECTED") {
        if (context?.gmail) context.gmail.connected = false;
      }
      post.send = { status: "idle", error: response.error };
    }
    render();
  }

  // ---------- Keeping in sync with other tabs ----------
  /** Take the server's copy of the application as the truth for this post. */
  function applyServerApplication(post, app) {
    if (!app) return;
    post.application = app;
    post.applicationId = app.id;
    post.baseUpdatedAt = app.updatedAt || null;
    if (app.email?.body) {
      post.fields = { to: app.email.to || "", subject: app.email.subject || "", body: app.email.body || "" };
      if (post.draft.status !== "loading") post.draft = { ...post.draft, status: "ready" };
    }
    if (app.resumeId) post.resumeId = app.resumeId;
    if (app.sentMessageId) {
      post.send = { status: "sent" };
      post.alreadyApplied = true;
    } else if (!["pick", "confirm", "sending", "scheduling", "cancelling"].includes(post.send.status)) {
      post.send = { status: "idle", warning: post.send.warning };
    }
  }

  /** Reload one post's application from the server. Never overrides edits not yet saved. */
  async function refreshPost(post, { note = null, fromSave = false } = {}) {
    if (!post?.applicationId || post.draft.status === "loading") return;
    if (post === current() && saveTimer) return;          // the user is typing here
    if (["sending", "scheduling", "cancelling"].includes(post.send.status)) return;
    if (!fromSave) await post.saving;                      // let an in-flight save land first
    const response = await sendToBackground({ type: "GET_APPLICATION", applicationId: post.applicationId });
    if (!response.success || !response.application) return;
    const changed = response.application.updatedAt !== post.baseUpdatedAt;
    if (!changed && !note) return;
    if (post === current() && saveTimer) return;           // started typing meanwhile
    applyServerApplication(post, response.application);
    post.duplicates = response.duplicates || post.duplicates;
    if (note) post.saveNote = note;
    render();
  }

  function refreshAll() {
    if (mode === "hidden") return;
    for (const post of posts) if (post.applicationId && post.draft.status !== "idle") refreshPost(post);
  }
  // Back to this LinkedIn tab (e.g. after editing in the dashboard) → reload.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
  window.addEventListener("focus", refreshAll);

  /** The server said our copy is out of date: reload and explain. */
  async function handleStale(post) {
    post.send = { status: "idle" };
    clearTimeout(saveTimer);
    saveTimer = null;
    await refreshPost(post, { note: "Changed in another tab: showing the latest version", fromSave: true });
  }

  // ---------- Send later ----------
  const scheduleOf = (post) => post?.application?.schedule || null;

  function openSchedulePicker(post) {
    if (!context) loadContext();
    const problem = validateBeforeSend(post);
    if (problem) {
      post.send = { status: "idle", error: problem };
      return render();
    }
    const current = scheduleOf(post)?.status === "scheduled" ? new Date(scheduleOf(post).sendAt) : null;
    const first = AF_SCHEDULE.presets().find(p => p.id === "tomorrow");
    post.send = { status: "pick", when: (current || first.when).toISOString() };
    render();
  }

  async function doSchedule(post, allowDuplicate = false) {
    const problem = validateBeforeSend(post) || AF_SCHEDULE.problem(post.send.when);
    if (problem) {
      post.send = { ...post.send, status: "pick", error: problem === "GMAIL" ? "Connect Gmail in Settings first." : problem };
      return render();
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    const when = post.send.when;
    post.send = { status: "scheduling", when };
    render();
    await post.saving;
    const response = await sendToBackground({
      type: "SCHEDULE_SEND",
      baseUpdatedAt: post.baseUpdatedAt,
      applicationId: post.applicationId,
      to: post.fields.to.trim(),
      subject: post.fields.subject.trim(),
      body: post.fields.body,
      resumeId: post.resumeId,
      sendAt: new Date(when).toISOString(),
      confirm: true,               // the user picked a time and clicked "Schedule"
      allowDuplicate
    });
    if (response.success) {
      applyServerApplication(post, response.application);
      post.send = { status: "idle", warning: response.warning || null };
    } else if (response.errorCode === "STALE") {
      return handleStale(post);
    } else if (response.errorCode === "DUPLICATE") {
      post.send = { status: "pick", when, duplicate: true, error: response.error };
    } else {
      post.send = { status: "pick", when, error: response.error };
    }
    render();
  }

  async function cancelScheduled(post) {
    post.send = { status: "cancelling" };
    render();
    const response = await sendToBackground({ type: "CANCEL_SCHEDULE", applicationId: post.applicationId });
    if (response.success) applyServerApplication(post, response.application);
    post.send = { status: "idle", error: response.success ? null : response.error };
    render();
  }

  function pickResume(post, resumeId) {
    if (!post || !resumeId || resumeId === post.resumeId) return;
    if (post.send.status === "sent" || post.send.status === "sending") return;
    if (post.edited && !confirm("Switch resume? The email will be rewritten for it and your edits will be replaced.")) return;
    startDraft(post, { resumeId });
  }

  // ---------- Events ----------
  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const post = current();

    switch (action) {
      case "open": openPanel(); break;
      case "close-toast": mode = "hidden"; toastAnimated = false; render(); break;
      case "close-panel": closePanel(); break;
      case "prev":
        if (index > 0) { flushSave(); index--; userBrowsing = true; afterNavigate(); }
        break;
      case "next":
        if (index < posts.length - 1) { flushSave(); index++; userBrowsing = true; afterNavigate(); }
        break;
      case "view":
        if (post?.element?.isConnected) {
          ignoreScrollUntil = Date.now() + 1500;
          post.element.scrollIntoView({ behavior: "smooth", block: "center" });
          post.element.style.outline = pageIsDark() ? "2px solid #F5F5F7" : "2px solid #0A0A0A";
          post.element.style.outlineOffset = "6px";
          post.element.style.borderRadius = "10px";
          setTimeout(() => { post.element.style.outline = ""; }, 2500);
        }
        break;
      case "full":
        sendToBackground({
          type: "OPEN_REVIEW",
          applicationId: post?.applicationId,
          postText: post?.postText,
          sourceUrl: post?.sourceUrl,
          localJob: post ? localJobForBackend(post.localJob) : null
        });
        break;
      case "dashboard":
        sendToBackground({ type: "OPEN_DASHBOARD", hash: target.dataset.hash || "" });
        break;
      case "retry":
        if (post) startDraft(post);
        break;
      case "generate":
        if (post && post.state !== "analysing") startDraft(post);
        break;
      case "reanalyse":
        if (post) { post.state = "detected"; analysePost(post, { force: true }); }
        break;
      case "remove-post":
        if (post) removePost(post.postId);
        break;
      case "regenerate":
        if (post && (!post.edited || confirm("Rewrite the email? Your edits will be replaced."))) startDraft(post, { regenerate: true });
        break;
      case "pick-resume":
        pickResume(post, target.dataset.id);
        break;
      case "send":
        if (post) onSendClick(post);
        break;
      case "confirm-send":
        if (post) doSend(post, false);
        break;
      case "send-anyway":
        if (post) doSend(post, true);
        break;
      case "cancel-send":
        clearTimeout(confirmTimer);
        if (post) { post.send = { status: "idle" }; render(); }
        break;
      case "schedule-open":
        if (post) openSchedulePicker(post);
        break;
      case "schedule-preset":
        if (post) { post.send = { ...post.send, when: target.dataset.when, error: null, duplicate: false }; renderFooterOnly(); }
        break;
      case "schedule-confirm":
        if (post) doSchedule(post, !!post.send.duplicate);
        break;
      case "schedule-cancel":
        if (post) cancelScheduled(post);
        break;
    }
  }

  function afterNavigate() {
    const post = current();
    render();
    if (mode === "panel" && post) analysePost(post);
    if (post?.applicationId && post.draft.status !== "idle") refreshPost(post);
  }

  function onInput(event) {
    const post = current();
    if (event.target.dataset.scheduleInput !== undefined && post) {
      const value = event.target.value ? new Date(event.target.value).toISOString() : "";
      post.send = { ...post.send, when: value, error: null, duplicate: false };
      const button = root.querySelector("[data-action='schedule-confirm'] .ellipsis");
      if (button) button.textContent = value ? `Schedule for ${AF_SCHEDULE.label(value)}` : "Pick a time";
      root.querySelectorAll(".chip[data-when]").forEach(c => c.classList.remove("on"));
      return;
    }
    const field = event.target.dataset.field;
    if (!field || !post) return;
    post.fields[field] = event.target.value;
    if (post.send.status === "confirm" || post.send.error) {
      post.send = { status: "idle" };
      renderFooterOnly();
    }
    if (field === "body") autoGrow(event.target);
    scheduleSave(post);
  }

  function autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight + 2, 560) + "px";
  }

  function setFootNote(text) {
    const el = root?.querySelector(".foot-note");
    if (el) el.textContent = text || "";
  }

  // ---------- Rendering ----------
  const e = (v) => escapeApplyFlowText(v ?? "");
  const I = AF_ICONS;

  function render() {
    if (!posts.length || mode === "hidden") {
      toastAnimated = false;
      host?.remove();
      host = null;
      stopTicker();
      return;
    }
    ensureHost();
    const layer = root.querySelector(".layer");
    layer.dataset.theme = pageIsDark() ? "dark" : "light";
    layer.innerHTML = mode === "panel" ? windowHtml() : toastHtml();
    if (mode === "toast") toastAnimated = true;
    if (mode === "panel") {
      if (!justOpened) root.querySelector(".window")?.classList.add("no-anim");
      justOpened = false;
      const body = root.querySelector("textarea[data-field='body']");
      if (body) autoGrow(body);
    }
    applyPosition();
    syncTicker();
  }

  function renderFooterOnly() {
    const foot = root?.querySelector(".foot");
    if (foot) foot.outerHTML = footerHtml(current());
  }

  const clean = (v) => (v && !/^(not specified|not identified|not found|hiring opportunity)$/i.test(v) ? v : "");

  function seconds(post) {
    return Math.round((Date.now() - post.startedAt) / 1000);
  }

  // ----- Notification -----
  function toastHtml() {
    const post = current();
    const job = post.job;
    const company = clean(job.companyName);
    const title = clean(job.jobTitle) || "Hiring opportunity";
    const kicker = posts.length > 1 ? `${posts.length} hiring posts` : "Hiring post detected";
    const nav = posts.length > 1 ? `
      <span class="toast-nav">
        <button class="nav-btn" data-action="prev" ${index === 0 ? "disabled" : ""} aria-label="Older post" title="Older post">${I.chevronLeft(12)}</button>
        <span class="nav-label">${index + 1}/${posts.length}</span>
        <button class="nav-btn" data-action="next" ${index === posts.length - 1 ? "disabled" : ""} aria-label="Newer post" title="Newer post">${I.chevronRight(12)}</button>
      </span>` : "";

    let right;
    if (post.state === "analysing") right = `<span class="pill ghost"><span class="spin"></span>Reading</span>`;
    else if (post.send.status === "sent" || post.alreadyApplied) right = `<span class="pill ghost">${I.check(13)}Applied</span>`;
    else if (scheduleOf(post)?.status === "scheduled") right = `<span class="pill ghost">${I.clock(13)}Scheduled</span>`;
    else right = `<span class="pill solid">View</span>`;

    return `
      <div class="toast${toastAnimated ? " no-anim" : ""}" data-action="open" role="button" tabindex="0" aria-label="Open ApplyFlow">
        <button class="dismiss" data-action="close-toast" aria-label="Dismiss">${I.close(11)}</button>
        ${I.logo(40)}
        <div class="toast-main">
          <div class="toast-kicker">${kicker}${nav}</div>
          <div class="toast-title">${e(title)}${company ? `<span class="at"> · ${e(company)}</span>` : ""}</div>
        </div>
        ${right}
      </div>`;
  }

  // ----- Floating window -----
  function navHtml() {
    if (posts.length < 2) return "";
    return `
      <span class="seg">
        <button class="icon-btn sm" data-action="prev" ${index === 0 ? "disabled" : ""} aria-label="Previous post">${I.chevronLeft(14)}</button>
        <span class="seg-label">${index + 1} of ${posts.length}</span>
        <button class="icon-btn sm" data-action="next" ${index === posts.length - 1 ? "disabled" : ""} aria-label="Next post">${I.chevronRight(14)}</button>
      </span>`;
  }

  function detailRow(label, value) {
    if (!clean(value)) return "";
    return `<div class="kv-row"><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
  }

  function windowHtml() {
    const post = current();
    const job = post.job;
    const meta = [clean(job.companyName), clean(job.location)].filter(Boolean).join(" · ");
    const recruiter = clean(job.recruiterName);
    const sourceBadge = post.state === "analysing" || post.state === "detected"
      ? `<span class="tag"><span class="spin"></span>Reading post</span>`
      : post.aiJob ? `<span class="tag">${I.sparkle(12)}Analysed by AI</span>` : `<span class="tag">Basic extraction</span>`;
    const levelTags = [job.employmentType, job.experienceLevel].filter(Boolean)
      .map(t => `<span class="tag">${e(t)}</span>`).join("");
    const appliedBefore = (post.duplicates || []).some(d => d.appliedAt) && post.send.status !== "sent";

    return `
      <aside class="window" role="dialog" aria-label="ApplyFlow application">
        <header class="head" data-drag title="Drag to move · double-click to reset">
          ${I.logo(26)}
          <span class="brand">ApplyFlow</span>
          <span class="spacer"></span>
          ${navHtml()}
          <button class="icon-btn" data-action="full" title="Open full page" aria-label="Open full page">${I.external(15)}</button>
          <button class="icon-btn" data-action="close-panel" title="Close (Esc)" aria-label="Close">${I.close(15)}</button>
        </header>

        <div class="body">
          <section class="job">
            <div class="row">${sourceBadge}${levelTags}${post.send.status === "sent" ? `<span class="tag ok">${I.check(12)}Applied</span>` : ""}</div>
            <h2>${e(clean(job.jobTitle) || "Hiring opportunity")}</h2>
            ${meta || recruiter ? `<p class="meta">${e(meta)}${meta && recruiter ? " · " : ""}${recruiter ? `Recruiter ${e(recruiter)}` : ""}</p>` : ""}
            ${appliedBefore ? `<div class="note">You've already applied to what looks like this same opening.</div>` : ""}
            ${summaryHtml(post)}
          </section>

          ${draftSectionHtml(post)}
        </div>

        ${footerHtml(post)}
      </aside>`;
  }

  // Job summary: shown in full until an application is generated, then folded away.
  function summaryHtml(post) {
    const job = post.job;
    if (post.state === "analysing" || post.state === "detected") {
      return `
        <div class="loading-line" style="margin-top:14px"><span class="spin"></span>Reading the post<span class="dots"></span> <span class="secs"></span></div>
        <div class="slow-hint" hidden>Taking longer than usual. <button class="link-btn" data-action="reanalyse">Try again</button></div>
        <div class="skeleton" style="height:14px;width:70%"></div>
        <div class="skeleton" style="height:14px;width:55%"></div>
        <div class="skeleton" style="height:14px;width:62%"></div>`;
    }
    const skills = (job.skills || []).length
      ? `<div class="sum-label">Skills</div><div class="chips">${job.skills.slice(0, 12).map(x => `<span class="chip solid">${e(x)}</span>`).join("")}</div>` : "";
    const reqs = (job.requirements || []).length
      ? `<div class="sum-label">Requirements</div><ul class="reqs">${job.requirements.map(x => `<li>${e(x)}</li>`).join("")}</ul>` : "";
    const rows = `
      <dl class="kv">
        ${detailRow("Experience", job.experience)}
        ${detailRow("Apply to", job.recruiterEmail)}
        ${detailRow("How to apply", job.applicationInstructions)}
        ${detailRow("Joining", job.joining)}
        ${detailRow("Deadline", job.deadline)}
      </dl>`;
    const notes = [
      post.notHiring ? `<div class="note">${I.warning(15)}<span>The AI doesn't think this is a job opening. <button class="link" data-action="remove-post">Remove it</button></span></div>` : "",
      post.state === "fallback" && post.error ? `<div class="note">${I.warning(15)}<span>${e(post.error)} Showing basic details. <button class="link" data-action="reanalyse">Try again</button></span></div>` : ""
    ].join("");
    const content = `${rows}${skills}${reqs}<button class="link" data-action="view">Show post on page</button>`;

    // Once an application exists, fold the summary so the email gets the space.
    if (post.draft.status !== "idle") {
      return `${notes}<details class="details"><summary>Job summary ${I.chevronRight(12)}</summary>${content}</details>`;
    }
    return `${notes}<div class="summary">${content}</div>`;
  }

  function draftSectionHtml(post) {
    if (post.draft.status === "idle") {
      if (post.state === "analysing" || post.state === "detected") return "";
      return `
        <section class="block">
          <p class="hint" style="margin:0">Ready when you are — <b>Generate application</b> picks your best resume and drafts the email in a few seconds.</p>
        </section>`;
    }
    if (post.draft.status === "loading") {
      const label = "Matching resumes and drafting your email";
      return `
        <section class="block">
          <div class="loading-line"><span class="spin"></span>${label}<span class="dots"></span> <span class="secs"></span></div>
          <div class="skeleton" style="height:58px"></div>
          <div class="skeleton" style="height:58px;opacity:.6"></div>
          <div class="skeleton" style="height:14px;width:30%;margin-top:22px"></div>
          <div class="skeleton" style="height:40px"></div>
          <div class="skeleton" style="height:40px"></div>
          <div class="skeleton" style="height:200px"></div>
        </section>`;
    }

    if (post.draft.status === "error") {
      const noResumes = post.draft.errorCode === "NO_RESUMES";
      const noKey = post.draft.errorCode === "NO_AI_KEY";
      return `
        <section class="block">
          <div class="note ${noResumes || noKey ? "" : "danger"}">${I.warning(15)}<span>${e(post.draft.error || "Something went wrong.")}</span></div>
          <div class="row" style="margin-top:12px">
            ${noResumes ? `<button class="btn" data-action="dashboard" data-hash="#resumes">${I.upload(14)}Upload resumes</button>` : ""}
            ${noKey ? `<button class="btn" data-action="dashboard" data-hash="#settings">Add your AI key</button>` : ""}
            <button class="btn" data-action="retry">${I.refresh(14)}Try again</button>
          </div>
        </section>`;
    }

    // Ready
    const app = post.application;
    const rankings = app?.match?.rankings || [];
    const resumes = context?.resumes || [];
    const nameOf = (id) => resumes.find(r => r.id === id)?.label || "Resume";
    const chosen = rankings.find(r => r.resumeId === post.resumeId);
    const locked = post.send.status === "sent" || post.send.status === "sending";
    const attachment = resumes.find(r => r.id === post.resumeId)?.originalName || nameOf(post.resumeId);

    const cards = rankings.map((r, i) => {
      const selected = r.resumeId === post.resumeId;
      const sub = i === 0
        ? `Best match${r.reasons?.[0] ? " · " + r.reasons[0] : ""}`
        : r.missingSkills?.length ? `Gaps · ${r.missingSkills.slice(0, 3).join(", ")}` : (r.reasons?.[0] || "");
      return `
        <button class="resume ${selected ? "selected" : ""}" data-action="pick-resume" data-id="${e(r.resumeId)}" ${locked ? "disabled" : ""} aria-pressed="${selected}">
          ${afScoreRing(r.score, 36)}
          <span class="resume-text">
            <span class="resume-name">${e(nameOf(r.resumeId))}</span>
            <span class="resume-sub">${e(sub)}</span>
          </span>
          ${selected ? `<span class="tick">${I.check(16)}</span>` : ""}
        </button>`;
    }).join("");

    return `
      <section class="block">
        <p class="label">Resume</p>
        <div class="resumes">${cards}</div>
        ${chosen?.missingSkills?.length ? `<div class="gaps"><span>Not on this resume</span>${chosen.missingSkills.slice(0, 5).map(x => `<span class="chip">${e(x)}</span>`).join("")}</div>` : ""}
      </section>

      <section class="block">
        ${app?.email?.eligibility && !locked ? `<div class="note" style="margin-bottom:12px">${I.warning(15)}<span><b>Check before sending:</b> ${e(app.email.eligibility)}</span></div>` : ""}
        <label class="label" for="af-to">To</label>
        <input id="af-to" type="email" data-field="to" value="${e(post.fields.to)}" placeholder="recruiter@company.com" ${locked ? "disabled" : ""}>
        ${post.fields.to ? "" : `<div class="hint">No email address in this post — check how they want you to apply.</div>`}

        <label class="label" for="af-subject">Subject</label>
        <input id="af-subject" type="text" data-field="subject" value="${e(post.fields.subject)}" ${locked ? "disabled" : ""}>

        <div class="label-row">
          <label class="label" for="af-body">Message</label>
          ${locked ? "" : `<button class="link" data-action="regenerate">${I.refresh(12)}Rewrite</button>`}
        </div>
        <textarea id="af-body" data-field="body" rows="12" ${locked ? "disabled" : ""}>${e(post.fields.body)}</textarea>

        <div class="attach">${I.attach(15)}<span class="attach-name">${e(attachment)}</span><span class="attach-meta">Drafted in ${e(post.draft.seconds)}s</span></div>
      </section>`;
  }

  function schedulePickerHtml(post) {
    const s = post.send;
    const busy = s.status === "scheduling";
    const chips = AF_SCHEDULE.presets().map(p => {
      const on = s.when && Math.abs(new Date(s.when) - p.when) < 60000;
      return `<button class="chip ${on ? "on" : ""}" data-action="schedule-preset" data-when="${p.when.toISOString()}" ${busy ? "disabled" : ""}>${e(p.label)}</button>`;
    }).join("");
    const lim = AF_SCHEDULE.limits();
    const value = s.when ? AF_SCHEDULE.toInput(new Date(s.when)) : "";
    return `
      <div class="picker">
        <div class="picker-title">${I.clock(15)}<strong>Send later</strong><span class="muted">sent from your Gmail, even if this laptop is off</span></div>
        <div class="chips">${chips}</div>
        <input type="datetime-local" class="when" data-schedule-input value="${value}" min="${lim.min}" max="${lim.max}" ${busy ? "disabled" : ""} aria-label="Send at">
        ${s.error ? `<div class="note ${s.duplicate ? "" : "danger"}">${I.warning(15)}<span>${e(s.error)}</span></div>` : ""}
      </div>
      <button class="btn primary wide" data-action="schedule-confirm" ${busy ? "disabled" : ""}>
        ${busy ? `<span class="spin inverse"></span>Scheduling…` : `${I.clock(16)}<span class="ellipsis">${s.duplicate ? "Schedule anyway for " : "Schedule for "}${e(AF_SCHEDULE.label(s.when) || "…")}</span>`}
      </button>
      <button class="link center" data-action="cancel-send" ${busy ? "disabled" : ""}>Back</button>`;
  }

  function footerHtml(post) {
    if (!post) return `<footer class="foot"></footer>`;
    const ready = post.draft.status === "ready";
    const s = post.send;
    let main;

    if (post.draft.status === "idle") {
      const reading = post.state === "analysing" || post.state === "detected";
      main = reading
        ? `<button class="btn primary wide" disabled><span class="spin inverse"></span>Reading the post…</button>`
        : `<button class="btn primary wide" data-action="generate">${I.sparkle(16)}Generate application</button>`;
    } else if (post.draft.status === "loading") {
      main = `<button class="btn primary wide" disabled><span class="spin inverse"></span>Drafting…</button>`;
    } else if (!ready) {
      main = `<button class="btn primary wide" disabled>${I.send(16)}Send application</button>`;
    } else if (s.status === "sent") {
      main = `
        <div class="sent">
          <span class="sent-check">${I.check(18)}</span>
          <div><strong>Application sent</strong><div class="foot-sub">To ${e(post.application?.email?.to || post.fields.to)} · tracked as Applied</div></div>
        </div>
        <button class="btn wide" data-action="close-panel">Done</button>`;
    } else if (s.status === "confirm") {
      main = `
        <button class="btn primary wide confirm" data-action="confirm-send" title="Send to ${e(post.fields.to.trim())}"><span class="ellipsis">Confirm — send to ${e(post.fields.to.trim())}</span></button>
        <button class="link center" data-action="cancel-send">Cancel</button>`;
    } else if (s.status === "sending") {
      main = `<button class="btn primary wide" disabled><span class="spin inverse"></span>Sending…</button>`;
    } else if (s.status === "pick" || s.status === "scheduling") {
      main = schedulePickerHtml(post);
    } else if (s.status === "cancelling") {
      main = `<button class="btn wide" disabled><span class="spin"></span>Cancelling…</button>`;
    } else if (scheduleOf(post)?.status === "scheduled") {
      const sch = scheduleOf(post);
      main = `
        ${s.warning ? `<div class="note">${I.warning(15)}<span>${e(s.warning)}</span></div>` : ""}
        ${s.error ? `<div class="note danger">${I.warning(15)}<span>${e(s.error)}</span></div>` : ""}
        <div class="sent scheduled">
          <span class="sent-check soft">${I.clock(18)}</span>
          <div><strong>Scheduled · ${e(AF_SCHEDULE.label(sch.sendAt))}</strong>
            <div class="foot-sub">To ${e(post.application?.email?.to || post.fields.to)} · you can still edit the email</div></div>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="schedule-open">${I.clock(15)}Change time</button>
          <button class="btn" data-action="send">${I.send(15)}Send now</button>
          <button class="btn" data-action="schedule-cancel">Cancel</button>
        </div>`;
    } else if (s.status === "duplicate") {
      main = `
        <div class="note">${e(s.error)}</div>
        <button class="btn primary wide confirm" data-action="send-anyway">Send again anyway</button>
        <button class="link center" data-action="cancel-send">Cancel</button>`;
    } else {
      let problem = "";
      if (s.error === "GMAIL" || (context && !context.gmail?.connected)) {
        problem = `<div class="note">${I.mail(15)}<span>${context?.gmail?.configured === false ? "Gmail isn't set up yet." : "Connect Gmail to send from here."}
          <button class="link" data-action="dashboard" data-hash="#settings">Open settings</button></span></div>`;
      } else if (s.error) {
        problem = `<div class="note danger">${I.warning(15)}<span>${e(s.error)}</span></div>`;
      }
      const failed = scheduleOf(post)?.status === "failed"
        ? `<div class="note danger">${I.warning(15)}<span>The scheduled email wasn't sent: ${e(scheduleOf(post).error || "unknown error")}</span></div>` : "";
      main = `${failed}${problem}
        <div class="send-row">
          <button class="btn primary wide" data-action="send">${I.send(16)}${failed ? "Send now" : "Send application"}</button>
          <button class="btn square" data-action="schedule-open" title="Send later" aria-label="Send later">${I.clock(18)}</button>
        </div>`;
    }

    return `
      <footer class="foot">
        ${main}
        <div class="foot-meta">
          <span class="foot-note">${e(post.saveNote || "")}</span>
          ${context?.gmail?.connected && s.status !== "sent" ? `<span>From ${e(context.gmail.email || "your Gmail")}</span>` : ""}
        </div>
      </footer>`;
  }

  // Elapsed-seconds counters while reading / drafting (updates text only, so clicks aren't lost).
  function syncTicker() {
    const post = current();
    const busy = posts.some(p => p.state === "analysing") || post?.draft.status === "loading";
    if (busy && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!busy) stopTicker();
  }
  function stopTicker() {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  function tick() {
    const post = current();
    if (!root || !post) return;
    const startedAt = post.draft.status === "loading" ? post.draft.startedAt : post.startedAt;
    const s = Math.round((Date.now() - startedAt) / 1000);
    root.querySelectorAll(".secs").forEach(el => { el.textContent = s > 2 ? `${s}s` : ""; });
    root.querySelectorAll(".slow-hint").forEach(el => { el.hidden = !(post.state === "analysing" && s >= 15); });
    if (!posts.some(p => p.state === "analysing") && post.draft.status !== "loading") stopTicker();
  }

  return { addPost, update, removePost };
})();


// (The AI now reads a post only when the user opens it — see analysePost() above.)



// Escape extracted text before inserting it into HTML.
function escapeApplyFlowText(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}


// ==========================================
// DESIGN — monochrome, Apple-like, light + dark
// ==========================================
const POPUP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }

  .layer {
    --glass: rgba(255, 255, 255, 0.84);
    --surface: #FFFFFF;
    --surface-2: #F5F5F7;
    --surface-3: #EBEBEF;
    --hairline: rgba(0, 0, 0, 0.07);
    --border: rgba(0, 0, 0, 0.12);
    --text: #1D1D1F;
    --text-2: #3A3A3C;
    --muted: #6E6E73;
    --faint: #8E8E93;
    --ink: #0A0A0A;
    --on-ink: #FFFFFF;
    --ink-hover: #2A2A2C;
    --focus: rgba(0, 0, 0, 0.16);
    --ok: #248A3D;
    --danger: #D70015;
    --danger-soft: rgba(215, 0, 21, 0.07);
    --shadow: 0 30px 80px rgba(0,0,0,0.18), 0 6px 18px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.06);
    --skeleton-a: #F0F0F3;
    --skeleton-b: #E4E4E9;
    font: 400 13.5px/1.5 "ApplyFlow Inter", "Inter", -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    font-feature-settings: "cv11", "ss01", "ss03";
    letter-spacing: -0.006em;
    -webkit-font-smoothing: antialiased;
    color: var(--text);
  }
  .layer[data-theme="dark"] {
    --glass: rgba(28, 28, 30, 0.82);
    --surface: #1C1C1E;
    --surface-2: #232325;
    --surface-3: #2C2C2E;
    --hairline: rgba(255, 255, 255, 0.08);
    --border: rgba(255, 255, 255, 0.14);
    --text: #F5F5F7;
    --text-2: #D1D1D6;
    --muted: #A1A1A6;
    --faint: #8E8E93;
    --ink: #F5F5F7;
    --on-ink: #0A0A0A;
    --ink-hover: #FFFFFF;
    --focus: rgba(255, 255, 255, 0.22);
    --ok: #30D158;
    --danger: #FF6961;
    --danger-soft: rgba(255, 105, 97, 0.12);
    --shadow: 0 30px 80px rgba(0,0,0,0.6), 0 6px 18px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.1);
    --skeleton-a: #232325;
    --skeleton-b: #2E2E31;
  }
  button { font: inherit; color: inherit; }
  svg { flex-shrink: 0; }

  /* Logo + score ring (markup from icons.js) */
  .af-logo-bg { fill: var(--ink); }
  .af-logo-fg { stroke: var(--on-ink); }
  .af-ring-track { stroke: var(--surface-3); }
  .af-ring-fill { stroke: var(--ink); transition: stroke-dasharray .4s; }
  .af-ring text { fill: var(--text); font-family: inherit; }

  /* ---------- Notification ---------- */
  .toast {
    position: fixed; z-index: 2147483647;
    width: 380px; display: flex; align-items: center; gap: 12px;
    padding: 12px 12px 12px 12px; border-radius: 20px; cursor: pointer;
    background: var(--glass);
    backdrop-filter: saturate(180%) blur(24px);
    -webkit-backdrop-filter: saturate(180%) blur(24px);
    box-shadow: var(--shadow);
    animation: drop .42s cubic-bezier(.2, .9, .25, 1.05);
    transition: transform .2s cubic-bezier(.2,.8,.2,1);
  }
  .toast:hover { transform: scale(1.015); }
  .toast:active { transform: scale(0.99); }
  .toast:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
  .toast-main { flex: 1; min-width: 0; }
  .toast-kicker { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .toast-title { margin-top: 1px; font-size: 14.5px; font-weight: 600; letter-spacing: -0.015em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toast-title .at { color: var(--muted); font-weight: 500; }
  .toast.no-anim { animation: none; }
  .toast-nav { display: inline-flex; align-items: center; gap: 1px; margin-left: auto; background: var(--surface-3); border-radius: 8px; padding: 1px; }
  .nav-btn { width: 20px; height: 18px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); cursor: pointer; padding: 0; }
  .nav-btn:hover:not(:disabled) { background: var(--surface); color: var(--text); }
  .nav-btn:disabled { opacity: .35; cursor: default; }
  .nav-label { font-size: 11px; font-weight: 600; color: var(--text-2); padding: 0 3px; font-variant-numeric: tabular-nums; }
  .slow-hint { margin-top: 10px; font-size: 12.5px; color: var(--muted); }
  .slow-hint[hidden] { display: none; }
  .link-btn { border: 0; background: none; padding: 0; color: var(--text); font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
  .dismiss {
    position: absolute; top: -7px; left: -7px; width: 22px; height: 22px; border-radius: 50%;
    border: 0.5px solid var(--border); background: var(--surface); color: var(--muted);
    display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .15s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.12);
  }
  .toast:hover .dismiss, .dismiss:focus-visible { opacity: 1; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 999px;
    font-size: 12.5px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap;
  }
  .pill.solid { background: var(--ink); color: var(--on-ink); }
  .pill.ghost { background: var(--surface-2); color: var(--text-2); }

  /* ---------- Floating window ---------- */
  .window {
    position: fixed; z-index: 2147483647;
    width: 420px; max-width: calc(100vw - 16px); height: 780px;
    display: flex; flex-direction: column; overflow: hidden;
    border-radius: 22px;
    background: var(--glass);
    backdrop-filter: saturate(180%) blur(30px);
    -webkit-backdrop-filter: saturate(180%) blur(30px);
    box-shadow: var(--shadow);
    transform-origin: top right;
    animation: expand .38s cubic-bezier(.2, .9, .25, 1);
  }
  .window.no-anim { animation: none; }
  .window.dragging { transition: none; box-shadow: 0 40px 100px rgba(0,0,0,0.28), 0 0 0 0.5px var(--border); }

  .head {
    display: flex; align-items: center; gap: 8px; padding: 12px 10px 12px 16px;
    border-bottom: 1px solid var(--hairline); cursor: grab; user-select: none; flex-shrink: 0;
  }
  .window.dragging .head { cursor: grabbing; }
  .brand { font-size: 14.5px; font-weight: 650; letter-spacing: -0.015em; }
  .spacer { flex: 1; }
  .icon-btn {
    width: 30px; height: 30px; border: none; background: transparent; border-radius: 9px;
    display: grid; place-items: center; cursor: pointer; color: var(--text-2);
    transition: background .15s, color .15s;
  }
  .icon-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
  .icon-btn:disabled { opacity: .3; cursor: default; }
  .icon-btn.sm { width: 26px; height: 26px; border-radius: 7px; }
  .seg { display: inline-flex; align-items: center; gap: 1px; background: var(--surface-3); border-radius: 10px; padding: 2px; margin-right: 2px; }
  .seg-label { font-size: 12px; font-weight: 500; color: var(--text-2); padding: 0 4px; font-variant-numeric: tabular-nums; }

  .body { flex: 1; overflow-y: auto; padding: 0 18px 8px; scrollbar-width: thin; scrollbar-color: var(--border) transparent; overscroll-behavior: contain; }

  .job { padding: 18px 0 16px; border-bottom: 1px solid var(--hairline); }
  .tag {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500;
    color: var(--text-2); border: 1px solid var(--border); padding: 3px 9px; border-radius: 999px;
  }
  .tag.ok { color: var(--ok); border-color: currentColor; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .job h2 { margin: 12px 0 3px; font-size: 22px; line-height: 1.22; font-weight: 700; letter-spacing: -0.028em; color: var(--text); }
  .meta { margin: 0; color: var(--muted); font-size: 13.5px; }
  .details { margin-top: 12px; }
  .details summary {
    cursor: pointer; color: var(--text-2); font-size: 13px; font-weight: 500; list-style: none;
    display: inline-flex; align-items: center; gap: 4px; user-select: none;
  }
  .details summary svg { transition: transform .2s; }
  .details[open] summary svg { transform: rotate(90deg); }
  .details summary::-webkit-details-marker { display: none; }
  .kv { margin: 12px 0 10px; display: grid; gap: 8px; }
  .summary { margin-top: 2px; }
  .summary > .link, .details .link { display: inline-block; margin-top: 12px; }
  .sum-label { font-size: 12px; font-weight: 600; color: var(--muted); margin: 12px 0 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip.solid { border-style: solid; }
  .reqs { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--text-2); }
  .kv-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }

  .block { padding: 16px 0 6px; }
  .block + .block { border-top: 1px solid var(--hairline); margin-top: 12px; }
  .label { display: block; margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .block > .label:first-child { margin-top: 0; }
  .label-row { display: flex; align-items: center; justify-content: space-between; }
  .label-row .label { margin-bottom: 6px; }

  .resumes { display: flex; flex-direction: column; gap: 8px; }
  .resume {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; text-align: left;
    border-radius: 14px; border: 1px solid var(--border); background: var(--surface); cursor: pointer;
    transition: border-color .15s, box-shadow .15s, transform .08s;
  }
  .resume:hover:not(:disabled) { border-color: var(--faint); }
  .resume:active:not(:disabled) { transform: scale(0.99); }
  .resume.selected { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
  .resume:disabled { cursor: default; opacity: .75; }
  .resume:not(.selected) .af-ring-fill { stroke: var(--faint); }
  .resume-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .resume-name { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .resume-sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tick { color: var(--ink); display: grid; }
  .gaps { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
  .gaps > span:first-child { font-size: 11.5px; color: var(--muted); margin-right: 2px; }
  .chip { font-size: 12px; color: var(--text-2); padding: 3px 9px; border-radius: 999px; border: 1px dashed var(--border); }

  input, textarea {
    width: 100%; border-radius: 12px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); padding: 10px 12px;
    font: 400 14px/1.5 "ApplyFlow Inter", "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
    letter-spacing: -0.006em;
    transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder, textarea::placeholder { color: var(--faint); }
  input:focus, textarea:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 4px var(--focus); }
  input:disabled, textarea:disabled { opacity: .7; }
  textarea { resize: none; min-height: 220px; line-height: 1.62; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }

  .attach {
    display: flex; align-items: center; gap: 9px; margin-top: 10px; padding: 9px 12px;
    border-radius: 12px; background: var(--surface-2); font-size: 13px; color: var(--text-2);
  }
  .attach-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach-meta { font-size: 12px; color: var(--faint); white-space: nowrap; }

  .loading-line { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--text-2); margin-bottom: 14px; }
  .dots::after { content: ""; animation: dots 1.2s steps(4, end) infinite; }
  .secs { color: var(--faint); font-variant-numeric: tabular-nums; }
  .skeleton {
    border-radius: 12px; margin-top: 10px;
    background: linear-gradient(90deg, var(--skeleton-a) 0%, var(--skeleton-b) 50%, var(--skeleton-a) 100%);
    background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite;
  }

  .note {
    display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px;
    font-size: 13px; line-height: 1.45; margin-top: 12px; background: var(--surface-2); color: var(--text-2);
  }
  .note svg { margin-top: 1px; }
  .note.danger { background: var(--danger-soft); color: var(--danger); }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 9px 14px; border-radius: 11px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-weight: 600; font-size: 13.5px; letter-spacing: -0.01em;
    cursor: pointer; transition: background .15s, transform .08s, opacity .15s;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); }
  .btn:active:not(:disabled) { transform: scale(0.985); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--ink); border-color: var(--ink); color: var(--on-ink); }
  .btn.primary:hover:not(:disabled) { background: var(--ink-hover); }
  .btn.wide { width: 100%; height: 48px; font-size: 15px; border-radius: 14px; }
  .btn.confirm { animation: ring 1.8s ease-in-out infinite; padding: 0 18px; }
  .ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link {
    display: inline-flex; align-items: center; gap: 5px; border: none; background: none; padding: 0;
    color: var(--text); cursor: pointer; font-size: 12.5px; font-weight: 600;
    text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px;
  }
  .link:hover { text-decoration-color: currentColor; }
  .link.center { display: flex; margin: 10px auto 0; color: var(--muted); font-weight: 500; text-decoration: none; }

  .spin {
    width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; display: inline-block;
    border: 2px solid var(--surface-3); border-top-color: var(--ink); animation: spin .7s linear infinite;
  }
  .spin.inverse { border-color: color-mix(in srgb, var(--on-ink) 30%, transparent); border-top-color: var(--on-ink); }

  .foot { flex-shrink: 0; padding: 12px 16px 14px; border-top: 1px solid var(--hairline); }
  .foot .note { margin: 0 0 10px; }
  .foot-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 8px; font-size: 11.5px; color: var(--faint); min-height: 16px; }
  .sent { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .sent-check {
    width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0;
    background: var(--ink); color: var(--on-ink); animation: pop .4s cubic-bezier(.2, 1.5, .4, 1);
  }
  .foot-sub { font-size: 12.5px; color: var(--muted); margin-top: 1px; }
  .send-row { display: flex; gap: 8px; }
  .send-row .btn.wide { flex: 1; }
  .btn.square { width: 48px; height: 48px; padding: 0; border-radius: 14px; flex-shrink: 0; }
  .btn-row { display: flex; gap: 8px; }
  .btn-row .btn { flex: 1; padding: 9px 8px; }
  .sent-check.soft { background: var(--surface-3); color: var(--text); animation: none; }
  .picker { margin-bottom: 12px; }
  .picker-title { display: flex; align-items: center; gap: 7px; font-size: 13.5px; margin-bottom: 10px; flex-wrap: wrap; }
  .picker-title .muted { color: var(--muted); font-size: 12px; font-weight: 400; flex-basis: 100%; margin-left: 22px; margin-top: -4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .chip { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 6px 11px; font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  .chip:hover:not(:disabled) { background: var(--surface-2); }
  .chip.on { background: var(--ink); border-color: var(--ink); color: var(--on-ink); }
  .when { width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; color-scheme: light dark; }
  .picker .note { margin: 10px 0 0; }

  @keyframes drop { from { opacity: 0; transform: translateY(-16px) scale(.97); } }
  @keyframes expand { from { opacity: 0; transform: scale(.92) translateY(-6px); border-radius: 28px; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
  @keyframes ring { 0%, 100% { box-shadow: 0 0 0 0 var(--focus); } 50% { box-shadow: 0 0 0 6px transparent; } }
  @keyframes pop { from { transform: scale(.3); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .toast, .window, .skeleton, .btn.confirm, .sent-check, .dots::after { animation: none; }
  }
  @media (max-width: 480px) {
    .toast { width: calc(100vw - 16px); }
  }
`;


// ==========================================
// START (at the end, so everything above is defined first)
// ==========================================

// Scan posts already loaded.
detectHiringPosts();

// Watch for new posts loaded while scrolling — batched so we scan at most
// every ~600ms instead of on every tiny DOM change.
let scanTimer = null;
const observer = new MutationObserver(() => {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    detectHiringPosts();
  }, 600);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
