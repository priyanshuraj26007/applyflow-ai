// ==========================================
// TINY JSON FILE STORE
// ==========================================
// Keeps data in backend/data/*.json. Writes go to a temp file first and are
// then renamed, so a crash mid-write never leaves a half-written file.
// Writes are queued per file so two requests can't overwrite each other.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.APPLYFLOW_DATA_DIR
  ? path.resolve(process.env.APPLYFLOW_DATA_DIR)
  : path.resolve(here, "..", "data");
export const RESUME_DIR = path.join(DATA_DIR, "resumes");

await fs.mkdir(RESUME_DIR, { recursive: true });

const queues = new Map();

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath(name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(name, value) {
  const target = filePath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Atomically read → modify → write a JSON file.
 * `mutator` receives the current value and returns { value, result }.
 */
export function updateJson(name, fallback, mutator) {
  const previous = queues.get(name) || Promise.resolve();
  const next = previous.then(async () => {
    const current = await readJson(name, fallback);
    const { value, result } = await mutator(current);
    await writeJson(name, value);
    return result;
  });
  // Keep the queue alive even if this update fails.
  queues.set(name, next.catch(() => {}));
  return next;
}
