// The website + download: the zip must match the extension folder, and the page
// must only reference files that exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { extensionFingerprint, PUBLIC_DIR, EXTENSION_DIR } = await import("../scripts/build-extension-zip.mjs");

test("the download zip is up to date with the extension folder (run: npm.cmd run build:zip)", () => {
  const info = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "extension.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  assert.equal(info.version, manifest.version, "zip version = manifest version");
  assert.equal(info.fingerprint, extensionFingerprint(),
    "The extension changed since the zip was built. Run `npm.cmd run build:zip` in /backend.");
  assert.ok(fs.statSync(path.join(PUBLIC_DIR, info.file)).size > 10_000);
});

test("the extension in the zip points at the hosted server, not a local one", () => {
  const config = fs.readFileSync(path.join(EXTENSION_DIR, "config.js"), "utf8");
  assert.match(config, /const APPLYFLOW_API = "https:\/\/[a-z0-9-]+\.vercel\.app";/);
});

test("every file the website links to exists", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:href|src|srcset)="(\/[^"#]+)"/g)].map(m => m[1]);
  assert.ok(refs.length > 5);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, ref)), `missing: ${ref}`);
  }
});

test("every setup step has a matching panel", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const steps = [...html.matchAll(/data-step="(\d+)"/g)].map(m => m[1]);
  const panels = [...html.matchAll(/data-panel="(\d+)"/g)].map(m => m[1]);
  assert.deepEqual(steps, panels);
});
