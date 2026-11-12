// ==========================================
// GMAIL — OAUTH 2.0 + SENDING
// ==========================================
// Uses a Google Cloud "Desktop app" OAuth client with a loopback redirect
// (http://127.0.0.1:<PORT>/auth/google/callback), PKCE and a CSRF `state`.
// We request only: gmail.send (send mail) + openid/email (show which account).
// We never see or store the user's Google password. The refresh token is
// stored locally in backend/data/gmail-tokens.json (git-ignored).
import crypto from "node:crypto";
import { readJson, updateJson } from "./store.js";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

export class GmailError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const pending = new Map(); // state -> { verifier, createdAt }

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const port = process.env.PORT || 3000;
  return { clientId, clientSecret, redirectUri: `http://127.0.0.1:${port}/auth/google/callback` };
}

export function isConfigured() {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
}

export async function getStatus() {
  const tokens = await readJson("gmail-tokens", null);
  return {
    configured: isConfigured(),
    connected: Boolean(tokens?.refresh_token),
    email: tokens?.email || null
  };
}

/** Step 1: build Google's consent URL. */
export function buildAuthUrl() {
  if (!isConfigured()) {
    throw new GmailError("GMAIL_NOT_CONFIGURED",
      "Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env (see README).", 400);
  }
  const { clientId, redirectUri } = config();
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  // Forget abandoned logins after 10 minutes.
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 600000) pending.delete(k);
  pending.set(state, { verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  return `${AUTH_URL}?${params}`;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.error || `HTTP ${response.status}`;
    if (reason === "invalid_grant") {
      throw new GmailError("GMAIL_RECONNECT", "Gmail access expired or was revoked. Please reconnect Gmail in the dashboard.", 401);
    }
    throw new GmailError("GMAIL_TOKEN_ERROR", `Google sign-in failed (${reason}).`, 502);
  }
  return data;
}

/** Step 2: Google redirects back with ?code&state — exchange for tokens. */
export async function handleCallback({ code, state, error }) {
  if (error) throw new GmailError("GMAIL_DENIED", `Google sign-in was cancelled (${error}).`);
  const entry = state && pending.get(state);
  if (!entry || !code) throw new GmailError("GMAIL_BAD_STATE", "This sign-in link is invalid or expired. Please try connecting again.");
  pending.delete(state);

  const { clientId, clientSecret, redirectUri } = config();
  const data = await tokenRequest({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: entry.verifier
  });

  if (!String(data.scope || "").includes("gmail.send")) {
    throw new GmailError("GMAIL_SCOPE", "Gmail send permission was not granted. Please tick the Gmail checkbox on Google's consent screen.");
  }

  const email = emailFromIdToken(data.id_token);
  await updateJson("gmail-tokens", null, (current) => ({
    value: {
      refresh_token: data.refresh_token || current?.refresh_token,
      access_token: data.access_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
      email,
      connectedAt: new Date().toISOString()
    },
    result: null
  }));
  return { email };
}

async function getAccessToken() {
  const tokens = await readJson("gmail-tokens", null);
  if (!tokens?.refresh_token) throw new GmailError("GMAIL_NOT_CONNECTED", "Connect your Gmail account in the dashboard first.", 401);
  if (tokens.access_token && tokens.expiry - Date.now() > 60000) return tokens.access_token;

  const { clientId, clientSecret } = config();
  const data = await tokenRequest({
    client_id: clientId, client_secret: clientSecret,
    refresh_token: tokens.refresh_token, grant_type: "refresh_token"
  });
  await updateJson("gmail-tokens", null, (current) => ({
    value: { ...current, access_token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 },
    result: null
  }));
  return data.access_token;
}

export async function disconnect() {
  const tokens = await readJson("gmail-tokens", null);
  if (tokens?.refresh_token) {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => {});
  }
  await updateJson("gmail-tokens", null, () => ({ value: {}, result: null }));
}

// ------------------------------------------
// MIME MESSAGE BUILDER
// ------------------------------------------
export const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const noNewlines = (v) => String(v || "").replace(/[\r\n]+/g, " ").trim();

function encodeHeader(value) {
  const v = noNewlines(value);
  // RFC 2047 for non-ASCII (e.g. "–" dashes, accented names)
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

const wrap76 = (b64) => b64.replace(/.{76}(?=.)/g, "$&\r\n");
const b64 = (text) => wrap76(Buffer.from(text, "utf8").toString("base64"));

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);

/**
 * Turn the plain-text email into clean, professional HTML:
 * blank lines → paragraphs, single line breaks → <br>, links clickable.
 * Everything is escaped first, so nothing in the text can inject HTML.
 */
export function textToHtml(body) {
  const paragraphs = String(body || "").replace(/\r/g, "").trim().split(/\n\s*\n/);
  const html = paragraphs.map((p) => {
    const safe = escapeHtml(p.trim())
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#4338CA;text-decoration:none">$1</a>')
      .replace(/\n/g, "<br>");
    return `<p style="margin:0 0 14px 0">${safe}</p>`;
  }).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:640px">
${html}
</div></body></html>`;
}

export function buildMimeMessage({ to, subject, body, attachment }) {
  const recipient = noNewlines(to);
  if (!EMAIL_RE.test(recipient)) throw new GmailError("BAD_RECIPIENT", "The recipient email address is not valid.");
  if (!noNewlines(subject)) throw new GmailError("EMPTY_SUBJECT", "The email subject is empty.");
  if (!String(body || "").trim()) throw new GmailError("EMPTY_BODY", "The email body is empty.");

  // Structure:  mixed ─┬─ alternative ─┬─ text/plain  (old email apps)
  //                    │               └─ text/html   (Gmail, Outlook… — what people see)
  //                    └─ application/pdf (resume)
  const boundary = `applyflow_${crypto.randomBytes(12).toString("hex")}`;
  const altBoundary = `applyflow_alt_${crypto.randomBytes(12).toString("hex")}`;
  const lines = [
    `To: ${recipient}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(String(body).replace(/\r?\n/g, "\r\n")),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(textToHtml(body)),
    `--${altBoundary}--`
  ];

  if (attachment) {
    const filename = noNewlines(attachment.filename).replace(/"/g, "'") || "resume.pdf";
    lines.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${encodeHeader(filename)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(attachment.content.toString("base64"))
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/** Send a message through the connected Gmail account. */
export async function sendEmail(message) {
  const mime = buildMimeMessage(message);
  const accessToken = await getAccessToken();
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822" },
    body: mime,
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.message || `HTTP ${response.status}`;
    if (response.status === 401) throw new GmailError("GMAIL_RECONNECT", "Gmail access expired. Please reconnect Gmail.", 401);
    if (response.status === 403) throw new GmailError("GMAIL_FORBIDDEN", `Gmail refused to send: ${reason}`, 403);
    throw new GmailError("GMAIL_SEND_FAILED", `Gmail could not send the email: ${reason}`, 502);
  }
  return { messageId: data.id, threadId: data.threadId };
}
