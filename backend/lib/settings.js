// ==========================================
// USER SETTINGS (sender profile + writing preferences + the tester's own AI keys)
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
  emailSkeleton: "",
  // The tester's own free AI keys. Never sent back to the browser in full (see publicSettings).
  groqApiKey: "",
  geminiApiKey: ""
};

const LIMITS = {
  senderName: 120, phone: 40, linkedinUrl: 300, signature: 600,
  emailTone: 120, extraInstructions: 1000, candidateNotes: 1000, styleExample: 4000,
  aboutMe: 60000, emailSkeleton: 4000
};

// Only a loose shape check: providers change key formats (Google issues several kinds of
// Gemini keys). Whether a key really works is checked with a tiny AI request when it is
// saved (dashboard → /api/test-gemini?provider=…). Empty string = remove the key.
const KEY_SHAPE = /^[A-Za-z0-9._~+\/=-]{20,300}$/;
const KEY_RULES = {
  groqApiKey: { re: KEY_SHAPE, name: "Groq" },
  geminiApiKey: { re: KEY_SHAPE, name: "Gemini" }
};

export class SettingsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson("settings", {})) };
}

const mask = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null);

/** Settings as the browser sees them: keys replaced by a masked hint. */
export function publicSettings(settings) {
  const { groqApiKey, geminiApiKey, ...rest } = settings;
  return { ...rest, keys: { groq: mask(groqApiKey), gemini: mask(geminiApiKey) } };
}

export async function saveSettings(input) {
  // Check keys before saving anything, so a typo gives a clear message.
  const keyUpdates = {};
  for (const [field, rule] of Object.entries(KEY_RULES)) {
    if (typeof input?.[field] !== "string") continue;   // not sent = keep the saved key
    const key = input[field].trim();
    if (key && !rule.re.test(key)) {
      throw new SettingsError("BAD_API_KEY", `That doesn't look like a ${rule.name} API key. Copy the whole key, with no spaces.`);
    }
    keyUpdates[field] = key;
  }

  return updateJson("settings", {}, (current) => {
    const next = { ...DEFAULT_SETTINGS, ...current, ...keyUpdates };
    for (const [key, max] of Object.entries(LIMITS)) {
      if (typeof input?.[key] === "string") next[key] = input[key].slice(0, max);
    }
    return { value: next, result: next };
  });
}
