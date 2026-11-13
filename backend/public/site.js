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
document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const id = link.getAttribute("href").slice(1);
  const target = id === "top" ? document.body : document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  if (id === "top") scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  else target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
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
  if (stepIndex === steps.length - 1) { $("#faq").scrollIntoView({ behavior: "smooth" }); return; }
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
    $("#setup").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }, 600);
});
