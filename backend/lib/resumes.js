// ==========================================
// RESUME LIBRARY
// ==========================================
// PDFs are stored as <random-id>.pdf in the tester's own storage space (never the
// user's filename, so no path tricks). Metadata + extracted text + AI profile live
// in the "resumes" document. AI analysis is cached by file hash. See lib/store.js.
import path from "node:path";
import crypto from "node:crypto";
import { readJson, updateJson, readFile, writeFile, removeFile } from "./store.js";
import { analyzeResume, JOB_CATEGORIES } from "./ai.js";

// Vercel rejects request bodies over 4.5 MB, so the hosted limit is 4 MB.
export const MAX_RESUME_BYTES = (process.env.VERCEL ? 4 : 5) * 1024 * 1024;
const MAX_MB = MAX_RESUME_BYTES / 1024 / 1024;
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
    throw new ResumeError("FILE_TOO_LARGE", `Resume must be ${MAX_MB} MB or smaller.`, 413);
  }
  // Real PDFs start with "%PDF-" (allow a little leading junk, as some generators add it).
  if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    throw new ResumeError("INVALID_FILE", "This file is not a valid PDF.");
  }
}

// The PDF reader is loaded only when a resume is uploaded, so a PDF-library problem
// can never stop the whole server from starting. "pdf-parse/worker" must load first:
// on Vercel it provides the graphics pieces (DOMMatrix…) that pdf.js expects, and
// makes Vercel bundle them.
let pdfLib = null;
async function loadPdfLib() {
  if (!pdfLib) {
    const worker = await import("pdf-parse/worker");
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(worker.getData());
    pdfLib = { PDFParse, CanvasFactory: worker.CanvasFactory };
  }
  return pdfLib;
}

export async function extractPdfText(buffer) {
  const { PDFParse, CanvasFactory } = await loadPdfLib();
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
  try {
    const result = await parser.getText();
    const text = (result.text || "")
      // Some PDF makers put invisible control characters (e.g. \u0000) in the text.
      // The database refuses them, so the upload failed with a 503. Drop them (keep \n and \t).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
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

/** linkedin.com/in/<name> found anywhere in the resume text, as a clean https URL. */
export function linkedinFromText(text) {
  const m = String(text || "").match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{2,100})/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
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
    profile: r.profile || null,
    // Used by Settings to fill in name / phone / LinkedIn for the user.
    contact: {
      name: r.profile?.name || null,
      phone: r.profile?.phone || null,
      linkedin: linkedinFromText(r.text)
    }
  };
}

export async function listResumes() {
  return (await readJson("resumes", EMPTY)).resumes;
}

export async function getResume(id) {
  return (await listResumes()).find(r => r.id === id) || null;
}

function resumeFileName(resume) {
  // id is always our own UUID — but double check it can't escape the folder.
  if (!/^[0-9a-f-]{36}$/.test(resume.id)) throw new ResumeError("BAD_ID", "Invalid resume id.");
  return `${resume.id}.pdf`;
}

/** The PDF bytes of a resume (Buffer). */
export async function readResumeFile(resume) {
  const buffer = await readFile(resumeFileName(resume));
  if (!buffer) throw new ResumeError("FILE_MISSING", "The resume file is missing. Please upload it again.", 404);
  return buffer;
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

  await writeFile(resumeFileName(record), buffer);
  try {
    await updateJson("resumes", EMPTY, (db) => {
      if (!db.resumes.length) record.isDefault = true; // first resume = default
      db.resumes.push(record);
      return { value: db, result: null };
    });
  } catch (error) {
    await removeFile(resumeFileName(record));
    throw error;
  }
  return publicResume(record);
}

export async function replaceResumeFile(id, { buffer, originalName }) {
  assertPdf(buffer);
  const existing = await getResume(id);
  if (!existing) throw new ResumeError("NOT_FOUND", "Resume not found.", 404);
  const { text, pages } = await extractPdfText(buffer);

  await writeFile(resumeFileName(existing), buffer);

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
  await removeFile(resumeFileName(removed));
  return { id };
}
