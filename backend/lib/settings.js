// ==========================================
// USER SETTINGS (sender profile + writing preferences)
// ==========================================
import { readJson, updateJson } from "./store.js";

export const DEFAULT_SETTINGS = {
  senderName: "",
  phone: "",
  linkedinUrl: "",
  signature: "",
  emailTone: "professional, warm and confident",
  extraInstructions: "",
  // An email the user likes — every draft copies its tone and structure.
  styleExample: "",
  // Extra notes used when an email needs facts like notice period / current CTC.
  candidateNotes: "",
  // Career profile written by the user's own AI (ChatGPT/Claude/Gemini) — see lib/about-me.js.
  aboutMe: "",
  // The user's email wording with [blanks] the AI fills in. Empty = DEFAULT_EMAIL_SKELETON (lib/ai.js).
  emailSkeleton: ""
};

const LIMITS = {
  senderName: 120, phone: 40, linkedinUrl: 300, signature: 600,
  emailTone: 120, extraInstructions: 1000, candidateNotes: 1000, styleExample: 4000,
  aboutMe: 60000, emailSkeleton: 4000
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson("settings", {})) };
}

export async function saveSettings(input) {
  return updateJson("settings", {}, (current) => {
    const next = { ...DEFAULT_SETTINGS, ...current };
    for (const [key, max] of Object.entries(LIMITS)) {
      if (typeof input?.[key] === "string") next[key] = input[key].slice(0, max);
    }
    return { value: next, result: next };
  });
}
