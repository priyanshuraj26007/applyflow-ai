// ==========================================
// SENDING AN APPLICATION (now, or later by the scheduler)
// ==========================================
// One place that checks, sends and records an application email, used by
// "Send" (server.js) and by scheduled sends (lib/scheduler.js), so both behave
// exactly the same: duplicate check, resume attached, status → Applied.
import { getApplication, modifyApplication, findDuplicates } from "./applications.js";
import { getResume, readResumeFile } from "./resumes.js";
import * as gmail from "./gmail.js";
import { currentUserId } from "./context.js";

export class SendError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const sending = new Set(); // "<tester>:<application>" being sent right now on this server

/** Throws SendError("DUPLICATE") if this opening was already applied to. */
export async function assertNotDuplicate(record) {
  const earlier = (await findDuplicates(record)).filter(d => d.appliedAt);
  if (record.sentMessageId || earlier.length) {
    throw new SendError("DUPLICATE", "You have already applied to this opening. Send again anyway?", 409, { duplicates: earlier });
  }
}

/**
 * Send an application email through the tester's Gmail with the chosen resume attached.
 * Returns the updated application. `scheduled` only changes the history wording.
 */
export async function sendApplication({ id, to, subject, body, resumeId, allowDuplicate = false, scheduled = false }) {
  const key = `${currentUserId()}:${id}`;
  if (sending.has(key)) throw new SendError("ALREADY_SENDING", "This application is already being sent.", 409);
  sending.add(key);
  try {
    const record = await getApplication(id);
    if (!record) throw new SendError("NOT_FOUND", "Application not found.", 404);
    if (!allowDuplicate) await assertNotDuplicate(record);

    const resume = await getResume(resumeId);
    if (!resume) throw new SendError("NO_RESUME", "Please choose a resume to attach.");
    const content = await readResumeFile(resume);
    const filename = resume.originalName || `${resume.label}.pdf`;

    const result = await gmail.sendEmail({ to, subject, body, attachment: { filename, content } });

    const updated = await modifyApplication(id, (a) => {
      const now = new Date().toISOString();
      a.email = { ...(a.email || {}), to: String(to).trim(), subject, body, resumeId };
      a.resumeId = resumeId;
      a.status = "Applied";
      a.appliedAt = now;
      a.sentMessageId = result.messageId;
      a.schedule = null;
      a.history.push({ at: now, event: `${scheduled ? "scheduled email sent" : "email sent"} to ${String(to).trim()} with ${resume.label}` });
    });
    console.log(`ApplyFlow AI: application sent${scheduled ? " (scheduled)" : ""} (${updated.job?.jobTitle || "role"}).`);
    return updated;
  } finally {
    sending.delete(key);
  }
}
