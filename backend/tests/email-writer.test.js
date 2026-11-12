// Tests the skeleton email writer, output parsing, parallel drafting and the
// "About me" condensing — with a FAKE AI and a throw-away data folder.
// Run with: npm.cmd test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.APPLYFLOW_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "applyflow-email-test-"));
process.env.AI_PROVIDERS = "gemini";
process.env.GEMINI_MODELS_DRAFT = "m-draft";
process.env.GEMINI_MODELS_SMART = "m-smart";

const { _setClientForTests } = await import("../lib/gemini.js");
const ai = await import("../lib/ai.js");
const { saveSettings, getSettings } = await import("../lib/settings.js");
const aboutMe = await import("../lib/about-me.js");

const EMAIL_TEXT = `Subject: Application for Data Analyst – Test User

Hi Priya,

I came across your post regarding the Data Analyst opportunity at Acme and wanted to reach out to express my interest.

I am a final-year Mechanical Engineering student at NSUT, interested in analytics and business problem-solving.

I have been building my skills in SQL, Python and Power BI, and have worked on projects including:
- **Zepto Inventory Insights**: used SQL to analyse pricing and stock trends.

What particularly interests me about Acme is the dashboard work described in the post.

I have attached my resume for your consideration and would appreciate the opportunity to discuss the role.

Best regards,
Test User

ELIGIBILITY: none`;

let prompts = [];
let order = [];
function fakeClient({ emailText = EMAIL_TEXT, condensed = "EDUCATION\n" + "- fact ".repeat(80) } = {}) {
  return {
    models: {
      async generateContent({ model, contents, config }) {
        prompts.push({ model, contents, json: !!config.responseSchema });
        if (config.responseSchema) { // resume matching
          order.push("match-start");
          await new Promise(r => setTimeout(r, 30));
          order.push("match-end");
          return { text: JSON.stringify({ rankings: [{ resumeId: "r1", score: 80, reasons: ["SQL"], missingSkills: [], relevantHighlights: [] }], recommendedResumeId: "r1" }) };
        }
        if (/FACT SHEET/.test(contents)) return { text: condensed };
        order.push("email");
        return { text: emailText };
      }
    }
  };
}

const resume = { id: "r1", label: "Analyst", profile: { name: "Test User", skills: ["SQL"] }, text: "Test User. NSUT. B.Tech Mechanical 2023-2027. SQL, Python." };
const job = { jobTitle: "Data Analyst", company: "Acme", recruiter: "Priya Nair" };

beforeEach(() => { prompts = []; order = []; _setClientForTests(fakeClient()); });

test("parseEmailOutput: subject, body and eligibility; markdown and sign-off removed", () => {
  const out = ai.parseEmailOutput(EMAIL_TEXT);
  assert.equal(out.subject, "Application for Data Analyst – Test User");
  assert.equal(out.eligibility, null);
  assert.ok(out.body.startsWith("Hi Priya,"));
  assert.ok(out.body.includes("- Zepto Inventory Insights: used SQL"), "bold removed, bullet kept");
  assert.ok(!/Best regards|Test User$/.test(out.body), "AI's own sign-off is cut");
  assert.ok(!/ELIGIBILITY/.test(out.body));
});

test("parseEmailOutput: real eligibility note is kept; '•' bullets become '- '", () => {
  const out = ai.parseEmailOutput("Subject: X\n\nHi Team,\n\n• Project A: did things\n\nELIGIBILITY: The post requires 2 actuarial exams cleared.");
  assert.equal(out.eligibility, "The post requires 2 actuarial exams cleared.");
  assert.ok(out.body.includes("- Project A: did things"));
});

test("writeEmail: fills the skeleton with facts + date, and adds the user's own sign-off", async () => {
  const settings = { senderName: "Test User", phone: "90000 00000", candidateNotes: "Notice period: none" };
  const email = await ai.writeEmail({ job, postText: "We're hiring a Data Analyst at Acme", resume, settings, profileText: "EDUCATION: NSUT, B.Tech 2027" });
  assert.ok(email.body.endsWith("Warm regards,\nTest User | 90000 00000"));
  assert.equal(email.eligibility, null);
  const p = prompts[0].contents;
  assert.ok(p.includes(ai.DEFAULT_EMAIL_SKELETON.slice(0, 40)), "uses the default skeleton");
  assert.ok(p.includes("EDUCATION: NSUT, B.Tech 2027"), "includes the About me profile");
  assert.ok(p.includes("Notice period: none"), "includes the user's extra facts");
  assert.match(p, /Today is \d{1,2} \w+ \d{4}/, "tells the AI today's date");
  assert.equal(prompts[0].json, false, "plain text, not JSON");
});

test("writeEmail: the user's own skeleton replaces the default", async () => {
  await ai.writeEmail({ job, postText: "post", resume, settings: { emailSkeleton: "Dear [name], MY OWN WORDING [blank]" }, profileText: null });
  assert.ok(prompts[0].contents.includes("MY OWN WORDING"));
  assert.ok(!prompts[0].contents.includes(ai.DEFAULT_EMAIL_SKELETON.slice(0, 40)));
});

test("writeEmail: a too-short answer is rejected", async () => {
  _setClientForTests(fakeClient({ emailText: "Subject: Hi\n\nToo short." }));
  await assert.rejects(ai.writeEmail({ job, postText: "post", resume, settings: {}, profileText: null }), (e) => e.code === "GEMINI_BAD_OUTPUT");
});

test("draftApplication: with one resume, matching and the email run in parallel", async () => {
  const d = await ai.draftApplication({ job, postText: "post", resumes: [resume], settings: { senderName: "Test User" }, profileText: null });
  assert.equal(d.emailResumeId, "r1");
  assert.equal(d.rankings[0].score, 80);
  assert.ok(d.body.includes("Hi Priya"));
  assert.ok(order.indexOf("email") < order.indexOf("match-end"), "email didn't wait for matching");
});

test("About me: saved, condensed once, then used for emails", async () => {
  const profile = "CAREER PROFILE\n" + "I am a final-year student at NSUT. ".repeat(40);
  const settings = await saveSettings({ aboutMe: profile });
  assert.equal((await aboutMe.aboutMeState(settings)).status, "pending");

  await aboutMe.condenseAboutMe(settings.aboutMe.trim());
  const state = await aboutMe.aboutMeState(await getSettings());
  assert.equal(state.status, "ready");
  assert.ok(state.words >= 60);
  assert.ok((await aboutMe.aboutMeForPrompt(await getSettings())).startsWith("EDUCATION"), "compact version is used");

  // Editing the profile makes the old condensed copy stale.
  const edited = await saveSettings({ aboutMe: profile + " New fact." });
  assert.equal((await aboutMe.aboutMeState(edited)).status, "pending");
  assert.ok((await aboutMe.aboutMeForPrompt(edited)).includes("New fact."), "full text used until re-condensed");
});

test("About me: a long profile (30k chars) is saved in full and condensed in parts", async () => {
  const para = "SECTION\n" + "I worked on market research and SQL analysis at NSUT. ".repeat(40);
  const long = Array.from({ length: 14 }, () => para).join("\n\n");
  assert.ok(long.length > 30000);
  const settings = await saveSettings({ aboutMe: long });
  assert.equal(settings.aboutMe.length, long.length, "nothing cut off");

  const parts = aboutMe.splitProfile(long);
  assert.ok(parts.length >= 3 && parts.every(p => p.length <= 12000), "split into request-sized parts");

  prompts = [];
  await aboutMe.condenseAboutMe(settings.aboutMe.trim());
  const condensePrompts = prompts.filter(p => /FACT SHEET/.test(p.contents));
  assert.equal(condensePrompts.length, parts.length, "one condense request per part");
  assert.ok(condensePrompts[0].contents.includes(`PART 1 of ${parts.length}`));
  assert.equal((await aboutMe.aboutMeState(await getSettings())).status, "ready");
});

test("About me: empty profile → emails use the resume only", async () => {
  const settings = await saveSettings({ aboutMe: "" });
  assert.equal((await aboutMe.aboutMeState(settings)).status, "none");
  assert.equal(await aboutMe.aboutMeForPrompt(settings), null);
});
