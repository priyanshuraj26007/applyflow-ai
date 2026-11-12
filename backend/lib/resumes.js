// ==========================================
// RESUME LIBRARY
// ==========================================
// PDFs are stored in backend/data/resumes/<random-id>.pdf (never the user's
// filename, so no path tricks). Metadata + extracted text + AI profile live
// in backend/data/resumes.json. AI analysis is cached by file hash.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PDFParse } from "pdf-parse";
import { RESUME_DIR, readJson, updateJson } from "./store.js";
import { analyzeResume, JOB_CATEGORIES } from "./ai.js";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024; // 5 MB
const EMPTY = { resumes: [] };

export class ResumeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const RESUME_CATEGORIES = [...JOB_CATEGORIES.filter(c => c !== "Other"), "General"];

function cleanLabel(label, fallback) {
  const v = typeof label === "string" ? label.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) : "";
  return v || fallback;
}
function cleanCategory(category) {
  return RESUME_CATEGORIES.includes(category) ? category : "General";
}
function cleanFileName(name) {
  const base = path.basename(String(name || "resume.pdf")).replace(/[^\w.\- ()]/g, "_").slice(0, 100);
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/** Check the bytes really are a PDF (not just a .pdf filename). */
export function assertPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ResumeError("INVALID_FILE", "The uploaded file is empty.");
  }
  if (buffer.length > MAX_RESUME_BYTES) {
    throw new ResumeError("FILE_TOO_LARGE", "Resume must be 5 MB or smaller.", 413);
  }
  // Real PDFs start with "%PDF-" (allow a little leading junk, as some generators add it).
  if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    throw new ResumeError("INVALID_FILE", "This file is not a valid PDF.");
  }
}

export async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = (result.text || "")
      .replace(/\r/g, "")
      .replace(/-- \d+ of \d+ --/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, pages: result.total };
  } catch (error) {
    throw new ResumeError("PDF_UNREADABLE", "Could not read this PDF (it may be encrypted or corrupted).");
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// What the API returns — never includes the full text or the file path.
export function publicResume(r) {
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    originalName: r.originalName,
    size: r.size,
    pages: r.pages,
    isDefault: !!r.isDefault,
    uploadedAt: r.uploadedAt,
    updatedAt: r.updatedAt,
    analysisStatus: r.analysisStatus,
    analysisError: r.analysisError || null,
    analysedWith: r.analysedWith || null,
    textLength: r.text?.length || 0,
    profile: r.profile || null
  };
}

export async function listResumes() {
  return (await readJson("resumes", EMPTY)).resumes;
}

export async function getResume(id) {
  return (await listResumes()).find(r => r.id === id) || null;
}

export function resumeFilePath(resume) {
  // id is always our own UUID — but double check it can't escape the folder.
  if (!/^[0-9a-f-]{36}$/.test(resume.id)) throw new ResumeError("BAD_ID", "Invalid resume id.");
  return path.join(RESUME_DIR, `${resume.id}.pdf`);
}

/** Run (or reuse cached) Gemini analysis for a resume and save the result. */
export async function analyseAndSave(id) {
  const resume = await getResume(id);
  if (!resume) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);

  if (!resume.text || resume.text.length < 100) {
    return updateResumeFields(id, {
      analysisStatus: "failed",
      analysisError: "Very little text could be read from this PDF. If it is a scanned image, please upload a text-based PDF."
    });
  }

  // Reuse an analysis of an identical file (same hash) to avoid paying twice.
  const all = await listResumes();
  const twin = all.find(r => r.id !== id && r.hash === resume.hash && r.profile);
  if (twin) {
    return updateResumeFields(id, {
      profile: twin.profile, analysisStatus: "done", analysisError: null, analysedWith: twin.analysedWith
    });
  }

  await updateResumeFields(id, { analysisStatus: "analysing", analysisError: null });
  try {
    const { profile, model } = await analyzeResume(resume.text);
    return updateResumeFields(id, { profile, analysisStatus: "done", analysisError: null, analysedWith: model });
  } catch (error) {
    console.error(`ApplyFlow AI: resume analysis failed [${error.code || "ERROR"}]: ${error.message}`);
    return updateResumeFields(id, { analysisStatus: "failed", analysisError: error.message });
  }
}

async function updateResumeFields(id, fields) {
  return updateJson("resumes", EMPTY, (db) => {
    const r = db.resumes.find(x => x.id === id);
    if (!r) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);
    Object.assign(r, fields, { updatedAt: new Date().toISOString() });
    return { value: db, result: publicResume(r) };
  });
}

export async function addResume({ buffer, originalName, label, category }) {
  assertPdf(buffer);
  const { text, pages } = await extractPdfText(buffer);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    label: cleanLabel(label, cleanFileName(originalName).replace(/\.pdf$/i, "")),
    category: cleanCategory(category),
    originalName: cleanFileName(originalName),
    size: buffer.length,
    pages,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    text,
    profile: null,
    analysisStatus: "pending",
    uploadedAt: now,
    updatedAt: now,
    isDefault: false
  };

  await fs.writeFile(resumeFilePath(record), buffer, { flag: "wx" });
  try {
    await updateJson("resumes", EMPTY, (db) => {
      if (!db.resumes.length) record.isDefault = true; // first resume = default
      db.resumes.push(record);
      return { value: db, result: null };
    });
  } catch (error) {
    await fs.unlink(resumeFilePath(record)).catch(() => {});
    throw error;
  }
  return publicResume(record);
}

export async function replaceResumeFile(id, { buffer, originalName }) {
  assertPdf(buffer);
  const existing = await getResume(id);
  if (!existing) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);
  const { text, pages } = await extractPdfText(buffer);

  const target = resumeFilePath(existing);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, target);

  return updateResumeFields(id, {
    originalName: cleanFileName(originalName),
    size: buffer.length,
    pages,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    text,
    profile: null,
    analysisStatus: "pending",
    analysisError: null,
    analysedWith: null
  });
}

export async function editResume(id, { label, category, isDefault }) {
  return updateJson("resumes", EMPTY, (db) => {
    const r = db.resumes.find(x => x.id === id);
    if (!r) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);
    if (label !== undefined) r.label = cleanLabel(label, r.label);
    if (category !== undefined) r.category = cleanCategory(category);
    if (isDefault === true) db.resumes.forEach(x => { x.isDefault = x.id === id; });
    r.updatedAt = new Date().toISOString();
    return { value: db, result: publicResume(r) };
  });
}

export async function deleteResume(id) {
  const removed = await updateJson("resumes", EMPTY, (db) => {
    const index = db.resumes.findIndex(x => x.id === id);
    if (index === -1) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);
    const [r] = db.resumes.splice(index, 1);
    if (r.isDefault && db.resumes.length) db.resumes[0].isDefault = true;
    return { value: db, result: r };
  });
  await fs.unlink(resumeFilePath(removed)).catch(() => {});
  return { id };
}
