// ==========================================
// ApplyFlow — product site interactions
// ==========================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Always open at the very top ----------
// Links like /#faq or a browser's remembered scroll position would otherwise open the
// page halfway down. The page always starts at the top; the menu links scroll smoothly
// without putting "#faq" into the address.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
scrollTo(0, 0);
addEventListener("pageshow", () => scrollTo(0, 0));
// Where a section's content really starts: its first heading/eyebrow, not the section's
// padded edge. Measured with offsetTop, which ignores the reveal animation's slide.
function contentTop(section) {
  const el = section.querySelector(".wrap") || section;   // content wrapper (no padding, never animated)
  let top = 0;
  for (let node = el; node; node = node.offsetParent) top += node.offsetTop;
  return top;
}
/** Scroll so the section's first line sits just below the menu bar. */
function goToSection(id) {
  if (id === "top") return scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  const section = document.getElementById(id);
  if (!section) return;
  const gap = 28;                                   // breathing room under the bar
  const y = contentTop(section) - $("#nav").offsetHeight - gap;
  scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? "auto" : "smooth" });
}
document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const id = link.getAttribute("href").slice(1);
  if (id !== "top" && !document.getElementById(id)) return;
  event.preventDefault();
  goToSection(id);
});

// ---------- Nav border once you scroll ----------
const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---------- Fade/slide sections in as they scroll into view ----------
const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
  }
}, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
$$(".reveal").forEach((el, i) => {
  // stagger siblings a little (bento tiles, cards)
  el.style.transitionDelay = `${Math.min((i % 4) * 70, 210)}ms`;
  io.observe(el);
});

// ---------- Download size / version from the build ----------
fetch("/extension.json", { cache: "no-store" })
  .then(r => (r.ok ? r.json() : null))
  .then(info => {
    if (!info) return;
    $("#dlMeta").textContent = `Free · version ${info.version} · ${info.sizeKb} KB · Windows & Mac`;
  })
  .catch(() => {});

// ---------- Old way vs ApplyFlow ----------
const tallies = { old: { steps: 9, tabs: 4, time: "~10" }, new: { steps: 3, tabs: 1, time: "<1" } };
function countTo(el, to) {
  if (typeof to !== "number" || reduceMotion) { el.textContent = to; return; }
  const from = parseInt(el.textContent, 10) || 0;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 500);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
$$(".toggle button").forEach(btn => btn.addEventListener("click", () => {
  const way = btn.dataset.way;
  $$(".toggle button").forEach(b => { b.classList.toggle("on", b === btn); b.setAttribute("aria-selected", b === btn); });
  $("#wayOld").classList.toggle("hidden", way !== "old");
  $("#wayNew").classList.toggle("hidden", way !== "new");
  $$(way === "old" ? "#wayOld li" : "#wayNew li").forEach((li, i) => {
    li.style.setProperty("--i", i);
    li.style.animation = "none"; void li.offsetWidth; li.style.animation = "";
  });
  countTo($("#tallySteps"), tallies[way].steps);
  countTo($("#tallyTabs"), tallies[way].tabs);
  $("#tallyTime").textContent = tallies[way].time;
  $("#tallyTime").nextElementSibling.textContent = way === "old" ? "minutes per job" : "minute per job";
}));
$$("#wayOld li").forEach((li, i) => li.style.setProperty("--i", i));

// ---------- Hero demo: ApplyFlow working on a LinkedIn-style feed ----------
const EMAIL = `Hi Ananya,

I came across your post about the Product Analyst opening at Northwind Health and wanted to express my interest.

I'm a final-year engineering student who has built SQL and Power BI dashboards for real business questions…`;

const demo = {
  feed: $(".feed"), post: $("#demoPost"), toast: $("#demoToast"), win: $("#demoWindow"),
  resume: $(".w-resume"), ring: $(".ring circle.fill"), score: $("#demoScore"),
  mail: $(".w-mail"), email: $("#demoEmail"), send: $("#demoSend"), caption: $("#demoCaption")
};
let demoVisible = false;
let demoRunning = false;

function caption(text) {
  demo.caption.style.opacity = 0;
  setTimeout(() => { demo.caption.textContent = text; demo.caption.style.opacity = 1; }, 200);
}
function resetDemo() {
  demo.feed.style.transform = "";
  demo.post.classList.remove("spotted");
  demo.toast.classList.remove("show", "press");
  demo.win.classList.remove("show");
  demo.resume.classList.remove("show");
  demo.ring.style.strokeDashoffset = 94.2;
  demo.score.textContent = "0";
  demo.mail.classList.remove("show", "done");
  demo.email.textContent = "";
  demo.send.classList.remove("press", "sent");
  demo.send.innerHTML = "<span>➤</span> Send application";
}
async function typeEmail() {
  for (let i = 0; i <= EMAIL.length; i += 3) {
    if (!demoVisible) return;
    demo.email.textContent = EMAIL.slice(0, i);
    await wait(16);
  }
  demo.email.textContent = EMAIL;
  demo.mail.classList.add("done");
}
async function playDemo() {
  if (demoRunning) return;
  demoRunning = true;
  while (demoVisible) {
    resetDemo();
    caption("Scroll your LinkedIn feed as usual…");
    await wait(1400);
    demo.feed.style.transform = "translateY(-60px)";
    await wait(1300);
    demo.post.classList.add("spotted");
    demo.toast.classList.add("show");
    caption("ApplyFlow spots the hiring post.");
    await wait(2200);
    demo.toast.classList.add("press");
    await wait(250);
    demo.toast.classList.remove("show");
    demo.win.classList.add("show");
    caption("One click: job summary and your best resume.");
    await wait(700);
    demo.resume.classList.add("show");
    demo.ring.style.strokeDashoffset = 94.2 * (1 - 0.86);
    for (let s = 0; s <= 86; s += 2) { demo.score.textContent = s; await wait(14); }
    demo.score.textContent = "86";
    await wait(600);
    demo.mail.classList.add("show");
    caption("A personal email, written in seconds.");
    await typeEmail();
    await wait(900);
    demo.send.classList.add("press");
    await wait(200);
    demo.send.classList.remove("press");
    demo.send.classList.add("sent");
    demo.send.innerHTML = "✓ Sent from your Gmail";
    caption("Sent from your Gmail, resume attached. Done.");
    await wait(3200);
  }
  demoRunning = false;
}
if (reduceMotion) {
  // Show the finished state, no animation.
  demo.toast.classList.remove("show");
  demo.win.classList.add("show");
  demo.resume.classList.add("show");
  demo.ring.style.strokeDashoffset = 94.2 * 0.14;
  demo.score.textContent = "86";
  demo.mail.classList.add("show", "done");
  demo.email.textContent = EMAIL;
  demo.caption.textContent = "Hiring post → personal email → sent from your Gmail.";
} else {
  new IntersectionObserver(([entry]) => {
    demoVisible = entry.isIntersecting;
    if (demoVisible) playDemo();
  }, { threshold: 0.3 }).observe($(".demo-stage"));
}

// ---------- Setup guide ----------
const steps = $$("#guideList li");
const panels = $$(".panel");
let stepIndex = 0;
function showStep(i, { scroll = false } = {}) {
  stepIndex = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((li, n) => {
    li.classList.toggle("on", n === stepIndex);
    li.classList.toggle("done", n < stepIndex);
  });
  panels.forEach(p => p.classList.toggle("on", Number(p.dataset.panel) === stepIndex));
  $("#stepCount").textContent = `Step ${stepIndex + 1} of ${steps.length}`;
  $("#prevStep").disabled = stepIndex === 0;
  $("#nextStep").textContent = stepIndex === steps.length - 1 ? "Done ✓" : "Next →";
  steps[stepIndex].scrollIntoView({ block: "nearest", inline: "center", behavior: reduceMotion ? "auto" : "smooth" });
  if (scroll) $(".guide-panels").scrollIntoView({ block: "nearest", behavior: "smooth" });
  // little "Developer mode" switch animation on step 2
  const knob = $("#devKnob");
  if (knob) { knob.classList.remove("on"); if (stepIndex === 1) setTimeout(() => knob.classList.add("on"), 500); }
}
steps.forEach((li, n) => li.addEventListener("click", () => showStep(n)));
$("#prevStep").addEventListener("click", () => showStep(stepIndex - 1, { scroll: true }));
$("#nextStep").addEventListener("click", () => {
  if (stepIndex === steps.length - 1) { goToSection("faq"); return; }
  showStep(stepIndex + 1, { scroll: true });
});
showStep(0);

// Windows / Mac (guess from the visitor's computer, can be switched)
function setOs(os) {
  $$(".os-toggle button").forEach(b => { b.classList.toggle("on", b.dataset.os === os); b.setAttribute("aria-selected", b.dataset.os === os); });
  $$(".os.win").forEach(el => el.classList.toggle("hidden", os !== "win"));
  $$(".os.mac").forEach(el => el.classList.toggle("hidden", os !== "mac"));
}
$$(".os-toggle button").forEach(b => b.addEventListener("click", () => setOs(b.dataset.os)));
setOs(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "mac" : "win");

// Copy buttons
$$(".copy").forEach(btn => btn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Select and copy";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1800);
}));

// After downloading, point people to the setup guide.
$("#downloadBtn").addEventListener("click", () => {
  setTimeout(() => {
    showStep(0);
    goToSection("setup");
  }, 600);
});

// ---------- "Still stuck? Ask your AI": one prompt with the whole setup guide ----------
function setupHelpPrompt() {
  const site = location.origin;
  const os = $(".os-toggle button.on")?.dataset.os === "mac" ? "Mac" : "Windows";
  const unzip = os === "Mac"
    ? "On Mac: open Downloads in Finder and double-click the zip."
    : "On Windows: open the Downloads folder, right-click the zip, choose \"Extract All...\", then \"Extract\".";
  return [
    `I'm setting up a free Chrome extension called ApplyFlow and I need your help. Please guide me through it patiently, ONE step at a time: tell me exactly what to click, then wait for me to say it worked (or describe what I see) before giving the next step. I'm on a ${os} computer, and I'm currently around step ${stepIndex + 1} of the guide below.`,
    "",
    "ABOUT APPLYFLOW",
    `ApplyFlow is a free browser extension for LinkedIn job hunting. It spots hiring posts in the LinkedIn feed, writes a personal application email with the user's best resume, and sends it from their own Gmail. It is in testing, so it is installed with Chrome's "Developer mode" instead of the Chrome Web Store. Website with the download and guide: ${site}`,
    "",
    "IMPORTANT RULES FOR YOU (the assistant)",
    "- Everything here is FREE: ApplyFlow, the Groq AI key and Gmail. No credit card is ever needed. If I see a page asking for payment or a card, tell me I took a wrong turn and help me get back.",
    "- Never ask me to paste my API key, passwords or Google secrets into this chat. I only paste the key into ApplyFlow's own Settings page.",
    "- It works in Google Chrome, Microsoft Edge or Brave on Windows or Mac, on the LinkedIn website (not the phone app).",
    "",
    "THE SETUP GUIDE (10 steps)",
    `1. Download and unzip: on ${site}, click "Download ApplyFlow" to get ApplyFlow-extension.zip. ${unzip} Move the "ApplyFlow" folder somewhere it can stay (e.g. Documents) and keep it: the browser runs ApplyFlow from this folder.`,
    "2. Turn on Developer mode: open a new tab and go to chrome://extensions (Edge: edge://extensions, Brave: brave://extensions). Switch on \"Developer mode\" in the top-right corner.",
    "3. Load ApplyFlow: click \"Load unpacked\" (it appears once Developer mode is on) and select the \"ApplyFlow\" FOLDER itself, not a file inside it. \"ApplyFlow AI\" appears in the list. If the browser later shows \"Disable developer mode extensions\", just close that message.",
    "4. Pin it: click the puzzle-piece icon at the top right of the browser, then the pin next to ApplyFlow, so its icon stays in the toolbar.",
    "5. Get a free AI key: open https://console.groq.com/keys, sign in (\"Continue with Google\" is quickest), click \"Create API Key\", give it any name, click \"Submit\" and copy the key. It starts with gsk_, and Groq shows it only once. Free, no card.",
    "6. Add the key: click the ApplyFlow toolbar icon, then \"Open Dashboard\", then \"Settings\". Paste the key under \"Your AI key\" and press \"Save\". It should say \"Groq key works\". (Optional: a free Gemini key from https://aistudio.google.com/apikey as a backup.)",
    "7. Upload a resume: Dashboard, then \"Resumes\", then upload the resume as a PDF (several versions are fine). Wait until it shows \"Ready\".",
    "8. Tell it about you: in Settings, check name, phone and LinkedIn URL (suggested from the resume) and press \"Save\". Then \"About me\": click \"Copy the prompt\", paste it into ChatGPT, Claude or Gemini, copy the answer back into the \"About me\" box and press \"Save\". After about a minute it shows \"Ready\".",
    "9. Connect Gmail: first send your Gmail address to the person who shared ApplyFlow with you, so they can add you as a tester. Then Settings, then \"Connect Gmail\". Google says \"Google hasn't verified this app\", which is normal for apps in testing: click \"Continue\", then tick \"Send email on your behalf\". ApplyFlow can only send emails you approve; it can't read the inbox. Google asks testers to reconnect every 7 days.",
    "10. Start applying: open or refresh the LinkedIn feed and scroll. A \"Hiring post detected\" notification appears at the top right. Click it for a job summary, then \"Generate application\", edit if needed, then \"Send\" and \"Confirm\" (or the clock button to send later). Nothing is ever sent without your click.",
    "",
    "COMMON PROBLEMS AND FIXES",
    "- No \"Load unpacked\" button: Developer mode is still off.",
    "- \"Manifest file is missing or unreadable\": the zip wasn't unzipped, or the wrong folder was chosen. Select the folder that directly contains manifest.json.",
    "- No notification on LinkedIn, or \"please refresh this LinkedIn page\": refresh LinkedIn (F5), especially after installing or reloading ApplyFlow.",
    "- \"Add your free Groq API key\": step 6 isn't done.",
    "- \"The AI is busy\": Groq's free speed limit (about two emails a minute). Wait a minute and try again.",
    "- \"Access blocked\" when connecting Gmail: the Gmail address hasn't been added as a tester yet (step 9).",
    "- \"Gmail access expired\": Settings, then \"Connect Gmail\" again.",
    "- Dashboard shows \"Offline\": check the internet connection; it reconnects by itself.",
    "",
    "Please start by asking me which step I'm on and what I see on my screen."
  ].join("\n");
}

$("#copyHelpPrompt").addEventListener("click", async () => {
  const btn = $("#copyHelpPrompt");
  const note = $("#copyHelpNote");
  const text = setupHelpPrompt();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers that block the clipboard API.
    const area = Object.assign(document.createElement("textarea"), { value: text });
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) { note.textContent = "Couldn't copy automatically. Please try another browser."; return; }
  }
  btn.textContent = "Copied ✓";
  btn.classList.add("copied");
  note.textContent = "Now open ChatGPT, Gemini or Claude, paste it (Ctrl+V, or ⌘+V on Mac) and press Enter.";
  setTimeout(() => { btn.textContent = "Copy setup prompt"; btn.classList.remove("copied"); }, 2500);
});
