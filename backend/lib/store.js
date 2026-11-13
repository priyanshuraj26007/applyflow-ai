// ==========================================
// STORAGE — one private space per tester
// ==========================================
// Two interchangeable drivers with the same functions:
//  - SUPABASE (hosted, used when SUPABASE_URL + SUPABASE_SECRET_KEY are set):
//      JSON documents → table applyflow_kv (user_id, name, value, version)
//      resume PDFs   → private storage bucket "resumes" at <user_id>/<file>
//  - FILES (your PC + tests): backend/data/users/<user_id>/<name>.json and files/
// The tester comes from the request context (lib/context.js), so callers just say
// readJson("settings") and get THEIR settings. `{ user }` overrides it (used for the
// shared "_oauth" space during Gmail sign-in).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentUserId, requestCache } from "./context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.APPLYFLOW_DATA_DIR
  ? path.resolve(process.env.APPLYFLOW_DATA_DIR)
  : path.resolve(here, "..", "data");

const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;          // document / file names we create ourselves
const SPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;           // tester IDs + "local" + "_oauth"

function space(options) {
  const user = options?.user || currentUserId();
  if (!SPACE_RE.test(user)) throw new Error("Invalid storage space.");
  return user;
}
function checkName(name) {
  if (!NAME_RE.test(name) || name.includes("..")) throw new Error(`Invalid storage name: ${name}`);
  return name;
}

// ------------------------------------------
// FILE DRIVER
// ------------------------------------------
// Windows briefly locks a file while another read of it is open (EPERM/EBUSY on rename):
// wait a moment and try again instead of failing the save.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 5) throw error;
      await new Promise(r => setTimeout(r, 30 * (attempt + 1)));
    }
  }
}
const fileDriver = {
  dir: (user) => path.join(DATA_DIR, "users", user),
  async read(user, name) {
    try {
      return { value: JSON.parse(await fs.readFile(path.join(this.dir(user), `${name}.json`), "utf8")) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  async write(user, name, value) {
    // Write to a temp file, then rename: a crash mid-write never leaves half a file.
    const dir = this.dir(user);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${name}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await renameWithRetry(tmp, target);
  },
  async remove(user, name) {
    await fs.unlink(path.join(this.dir(user), `${name}.json`)).catch(() => {});
  },
  async readFile(user, name) {
    try {
      return await fs.readFile(path.join(this.dir(user), "files", name));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  async writeFile(user, name, buffer) {
    const dir = path.join(this.dir(user), "files");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    await fs.writeFile(`${target}.tmp`, buffer);
    await renameWithRetry(`${target}.tmp`, target);
  },
  async removeFile(user, name) {
    await fs.unlink(path.join(this.dir(user), "files", name)).catch(() => {});
  }
};

// ------------------------------------------
// SUPABASE DRIVER
// ------------------------------------------
const TABLE = "applyflow_kv";
const BUCKET = "resumes";
let supabase = null;

/** The shared Supabase client (hosted mode only). */
export async function supabaseClient() {
  return db();
}

async function db() {
  if (!supabase) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabase;
}

function dbError(action, error) {
  console.error(`ApplyFlow AI: database ${action} failed: ${error?.message || error}`);
  return Object.assign(new Error("The ApplyFlow database is not responding. Please try again."), {
    code: "STORAGE_ERROR", status: 503
  });
}

/**
 * Postgres jsonb refuses the null character (\u0000) and broken surrogate pairs, which
 * can arrive in text copied from PDFs or web pages. Strip them from every string before
 * saving, so one odd character can never make a save fail.
 */
export function jsonSafe(value) {
  if (typeof value === "string") {
    return value.includes("\u0000") || /[\uD800-\uDFFF]/.test(value)
      ? value.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      : value;
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [jsonSafe(k), jsonSafe(v)]));
  }
  return value;
}

const supabaseDriver = {
  async read(user, name) {
    const { data, error } = await (await db()).from(TABLE)
      .select("value, version").eq("user_id", user).eq("name", name).maybeSingle();
    if (error) throw dbError("read", error);
    return data ? { value: data.value, version: data.version } : null;
  },
  /** Write only if nobody changed the document since we read it. Returns false on a clash. */
  async writeIfUnchanged(user, name, rawValue, version) {
    const client = await db();
    const value = jsonSafe(rawValue);
    if (version === undefined) {
      const { error } = await client.from(TABLE).insert({ user_id: user, name, value, version: 1 });
      if (error?.code === "23505") return false;   // someone else created it first
      if (error) throw dbError("insert", error);
      return true;
    }
    const { data, error } = await client.from(TABLE)
      .update({ value, version: version + 1, updated_at: new Date().toISOString() })
      .eq("user_id", user).eq("name", name).eq("version", version)
      .select("version");
    if (error) throw dbError("update", error);
    return data.length === 1;
  },
  async remove(user, name) {
    const { error } = await (await db()).from(TABLE).delete().eq("user_id", user).eq("name", name);
    if (error) throw dbError("delete", error);
  },
  async readFile(user, name) {
    const { data, error } = await (await db()).storage.from(BUCKET).download(`${user}/${name}`);
    if (error) {
      if (/not.?found|404/i.test(`${error.message} ${error.statusCode || ""}`)) return null;
      throw dbError("file download", error);
    }
    return Buffer.from(await data.arrayBuffer());
  },
  async writeFile(user, name, buffer) {
    const { error } = await (await db()).storage.from(BUCKET)
      .upload(`${user}/${name}`, buffer, { contentType: "application/pdf", upsert: true });
    if (error) throw dbError("file upload", error);
  },
  async removeFile(user, name) {
    const { error } = await (await db()).storage.from(BUCKET).remove([`${user}/${name}`]);
    if (error) console.warn(`ApplyFlow AI: could not delete stored file: ${error.message}`);
  }
};

export const USING_SUPABASE = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
const driver = USING_SUPABASE ? supabaseDriver : fileDriver;

// ------------------------------------------
// PUBLIC API (same for both drivers)
// ------------------------------------------
// Within one request each document is fetched from the database only once (a request
// often needs settings/resumes several times). Writes update this copy too. Callers get
// their own clone, so changing what they receive never changes the cached copy.
const cacheKey = (user, name) => `doc:${user}/${name}`;

export async function readJson(name, fallback, options) {
  const user = space(options);
  checkName(name);
  const cache = requestCache();
  const key = cacheKey(user, name);
  if (!cache?.has(key)) {
    const loading = driver.read(user, name).then(found => (found ? found.value : undefined));
    if (!cache) {
      const value = await loading;
      return value === undefined ? structuredClone(fallback) : value;
    }
    cache.set(key, loading.catch((error) => { cache.delete(key); throw error; }));
  }
  const value = await cache.get(key);
  return structuredClone(value === undefined ? fallback : value);
}

function remember(user, name, value) {
  requestCache()?.set(cacheKey(user, name), Promise.resolve(structuredClone(value)));
}
function forget(user, name) {
  requestCache()?.delete(cacheKey(user, name));
}

// Updates of the same document from this server instance run one after another.
const queues = new Map();

/**
 * Atomically read → modify → write a JSON document.
 * `mutator` receives the current value and returns { value, result }.
 * With Supabase, several server instances may run at once: if the document changed
 * between our read and write, we re-read and run the mutator again (up to 5 times).
 */
export function updateJson(name, fallback, mutator, options) {
  const user = space(options);
  checkName(name);
  const key = `${user}/${name}`;
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    if (!USING_SUPABASE) {
      const found = await fileDriver.read(user, name);
      const { value, result } = await mutator(found ? found.value : structuredClone(fallback));
      await fileDriver.write(user, name, value);
      remember(user, name, value);
      return result;
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const found = await supabaseDriver.read(user, name);
      const { value, result } = await mutator(found ? found.value : structuredClone(fallback));
      if (await supabaseDriver.writeIfUnchanged(user, name, value, found?.version)) {
        remember(user, name, value);
        return result;
      }
      await new Promise(r => setTimeout(r, 50 * attempt + Math.random() * 100));
    }
    throw Object.assign(new Error("Too many changes at once. Please try again."), { code: "STORAGE_BUSY", status: 503 });
  });
  // Keep the queue alive even if this update fails; forget it once it is idle.
  const settled = next.catch(() => {});
  queues.set(key, settled);
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}

export async function deleteJson(name, options) {
  const user = space(options);
  await driver.remove(user, checkName(name));
  forget(user, name);
}

/** Binary files (resume PDFs). Returns a Buffer, or null if missing. */
export async function readFile(name, options) {
  return driver.readFile(space(options), checkName(name));
}
export async function writeFile(name, buffer, options) {
  await driver.writeFile(space(options), checkName(name), buffer);
}
export async function removeFile(name, options) {
  await driver.removeFile(space(options), checkName(name));
}
