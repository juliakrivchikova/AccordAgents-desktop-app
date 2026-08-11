import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("packaged Windows application excludes generated renderer test bundles", () => {
  assert.equal(existsSync(rendererTestBundle), true, "renderer test bundle should exist before packaging");
  assert.equal(existsSync(packagedApp), true, "Windows package should contain app.asar");

  const entries = asar.listPackage(packagedApp).map((entry) => entry.replaceAll("\\", "/"));
  const testEntries = entries.filter((entry) =>
    /\/dist\/(?:renderer-tests(?:-[^/]+)?|codex-approval-renderer-test)(?:\/|$)|\/(?:test|tests|__tests__)(?:\/|$)|\.test\.(?:[cm]?js)$/i.test(entry)
  );

  assert.deepEqual(testEntries, []);
  assert.equal(existsSync(packagedNativePty), true, "Windows package should unpack the native ConPTY module");
});
