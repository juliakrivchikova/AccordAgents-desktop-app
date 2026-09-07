import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import asar from "@electron/asar";

const rootDir = process.cwd();
const packagedApp = path.join(rootDir, "out", "AccordAgents-win32-x64", "resources", "app.asar");
const packagedNativePty = path.join(
  rootDir,
  "out",
  "AccordAgents-win32-x64",
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "node-pty",
  "prebuilds",
  "win32-x64",
  "conpty.node"
);
const rendererTestBundle = path.join(
  rootDir,
  "dist",
  "renderer-tests",
  "renderer",
  "components",
  "chat",
  "chat-composer-mention-token.test.mjs"
);

// Only meaningful after `npm run package -- --platform=win32`; skipped when a
// different platform was packaged so this file can be run after any package.
test("packaged Windows application excludes generated renderer test bundles", (t) => {
  if (!existsSync(packagedApp)) {
    t.skip("no Windows package in out/");
    return;
  }
  assert.equal(existsSync(rendererTestBundle), true, "renderer test bundle should exist before packaging");

  const entries = asar.listPackage(packagedApp).map((entry) => entry.replaceAll("\\", "/"));
  const testEntries = entries.filter((entry) =>
    /\/dist\/(?:renderer-tests(?:-[^/]+)?|codex-approval-renderer-test)(?:\/|$)|\/(?:test|tests|__tests__)(?:\/|$)|\.test\.(?:[cm]?js)$/i.test(entry)
  );

  assert.deepEqual(testEntries, []);
  assert.equal(existsSync(packagedNativePty), true, "Windows package should unpack the native ConPTY module");

  // The Linux machine payload must NOT be in the asar: rsync copies real files
  // to a machine, and nothing inside an asar has a path on disk.
  const payloadEntries = entries.filter((entry) => /\/dist\/machine(?:\/|$)/.test(entry));
  assert.deepEqual(payloadEntries, [], "the machine payload must ship as a loose resource, not inside the asar");
});

// Every packaged application must be able to install a machine without a
// source checkout, so the runtime payload and its manifest ship as resources.
for (const resourcesDir of packagedResourceDirs()) {
  test(`${packageLabel(resourcesDir)} carries a complete machine payload`, () => {
    const payloadDir = path.join(resourcesDir, "machine");
    assert.equal(existsSync(payloadDir), true, `machine payload missing from ${resourcesDir}`);
    for (const required of ["accordagents-machine.cjs", "nativeProcessSupervisor.cjs", "package.json", "payload.json"]) {
      assert.equal(existsSync(path.join(payloadDir, required)), true, `machine payload is missing ${required}`);
    }
    const manifest = JSON.parse(readFileSync(path.join(payloadDir, "payload.json"), "utf8"));
    assert.equal(manifest.manifestVersion, 1);
    assert.ok(manifest.files.length > 0);
    for (const file of manifest.files) {
      const full = path.join(payloadDir, file.path);
      assert.equal(existsSync(full), true, `machine payload is missing ${file.path}`);
      const contents = readFileSync(full);
      assert.equal(contents.byteLength, file.bytes, `${file.path} was truncated on the way into the package`);
      assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256, `${file.path} does not match the build`);
    }
    // Packaging must not introduce a link the manifest does not describe:
    // `rsync -a` would copy it to the machine unverified.
    assert.deepEqual(nonRegularEntries(payloadDir), [], "the packaged payload must contain only regular files and directories");
    // The payload the app would install must be the version the app is.
    const appVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
    const payloadVersion = JSON.parse(readFileSync(path.join(payloadDir, "package.json"), "utf8")).version;
    assert.equal(payloadVersion, appVersion, "the packaged runtime payload is from a different build than the app");
    assert.equal(manifest.version, appVersion);
  });
}

function nonRegularEntries(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...nonRegularEntries(path.join(dir, entry.name), relative));
    else if (!entry.isFile()) found.push(relative);
  }
  return found;
}

function packageLabel(resourcesDir) {
  const relative = path.relative(path.join(rootDir, "out"), resourcesDir);
  return relative.split(path.sep)[0] ?? relative;
}

function packagedResourceDirs() {
  const outDir = path.join(rootDir, "out");
  if (!existsSync(outDir)) return [];
  const dirs = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("AccordAgents-")) continue;
    const base = path.join(outDir, entry.name);
    const macResources = path.join(base, "AccordAgents.app", "Contents", "Resources");
    const otherResources = path.join(base, "resources");
    if (existsSync(macResources)) dirs.push(macResources);
    else if (existsSync(otherResources)) dirs.push(otherResources);
  }
  return dirs;
}
