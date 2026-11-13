// ==========================================
// Build the extension download: public/ApplyFlow-extension.zip
// ==========================================
// Run after changing anything in /extension:   npm.cmd run build:zip   (from /backend)
// The zip contains one folder, "ApplyFlow", which testers select in Chrome's
// "Load unpacked". public/extension.json tells the website the version + size.
// A test (tests/site.test.js) fails if the zip is out of date, so it can't be forgotten.
// No dependencies: a small ZIP writer using Node's built-in zlib.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = path.resolve(here, "..", "..", "extension");
export const PUBLIC_DIR = path.resolve(here, "..", "public");
const ZIP_NAME = "ApplyFlow-extension.zip";
const FOLDER = "ApplyFlow";

/** Every file of the extension (sorted, so the result is the same on every PC). */
export function extensionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(EXTENSION_DIR);
  return out;
}

/** Fingerprint of the extension's contents (line endings ignored, so Windows/Mac agree). */
export function extensionFingerprint() {
  const hash = crypto.createHash("sha256");
  for (const file of extensionFiles()) {
    hash.update(path.relative(EXTENSION_DIR, file).replace(/\\/g, "/"));
    const data = fs.readFileSync(file);
    hash.update(/\.(js|json|html|css|svg|txt|md)$/i.test(file) ? Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n")) : data);
  }
  return hash.digest("hex").slice(0, 16);
}

// ---------- minimal ZIP writer ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed date → identical zips

function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function buildZip() {
  const files = extensionFiles();
  const entries = files.map(file => ({
    name: `${FOLDER}/${path.relative(EXTENSION_DIR, file).replace(/\\/g, "/")}`,
    data: fs.readFileSync(file)
  }));
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const buffer = zip(entries);
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, ZIP_NAME), buffer);
  const info = {
    version: manifest.version,
    file: ZIP_NAME,
    sizeKb: Math.round(buffer.length / 1024),
    files: entries.length,
    fingerprint: extensionFingerprint()
  };
  fs.writeFileSync(path.join(PUBLIC_DIR, "extension.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = buildZip();
  console.log(`Built public/${info.file}: version ${info.version}, ${info.files} files, ${info.sizeKb} KB`);
}
