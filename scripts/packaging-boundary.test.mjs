import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createPackage } from "@electron/asar";
import { verifyRuntimeArchive, verifyUpdaterZip } from "./packaging-boundary.mjs";

const root = process.cwd();
const require = createRequire(path.join(root, "forge.config.ts"));
const { userPathFilter, populateIgnoredPaths } = require("@electron/packager/dist/copy-filter.js");
const source = await readFile(path.join(root, "forge.config.ts"), "utf8");

function configFor(platform) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, require, __dirname: root,
    process: { platform, env: {} }
  });
  return module.exports.default.packagerConfig;
}

test("release checks reject contaminated archives and oversized update downloads", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "accord-release-boundary-"));
  try {
    const input = path.join(temporary, "input");
    for (const file of ["package.json", "dist/main/main/launcher.js", "dist/main/preload/index.js", "dist/renderer/index.html"]) {
      await mkdir(path.dirname(path.join(input, file)), { recursive: true });
      await writeFile(path.join(input, file), "fixture");
    }
    const clean = path.join(temporary, "clean.asar");
    await createPackage(input, clean);
    assert.doesNotThrow(() => verifyRuntimeArchive(clean));
    await mkdir(path.join(input, ".scratch"));
    await writeFile(path.join(input, ".scratch/chat.sqlite3"), "private fixture");
    const contaminated = path.join(temporary, "contaminated.asar");
    await createPackage(input, contaminated);
    assert.throws(() => verifyRuntimeArchive(contaminated), /non-runtime files/);
    await rm(path.join(input, ".scratch"), { recursive: true });
    await rm(path.join(input, "dist/main/preload/index.js"));
    const incomplete = path.join(temporary, "incomplete.asar");
    await createPackage(input, incomplete);
    assert.throws(() => verifyRuntimeArchive(incomplete), /missing.*preload/);
    const zip = path.join(temporary, "update.zip");
    await writeFile(zip, "fixture");
    await truncate(zip, 1024 ** 3 - 1);
    assert.doesNotThrow(() => verifyUpdaterZip(zip));
    await truncate(zip, 1024 ** 3);
    assert.throws(() => verifyUpdaterZip(zip), /smaller than 1 GiB/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} packaging copies runtime files without workspace data`, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "accord-packaging-boundary-"));
    try {
      const input = path.join(temporary, "input");
      const output = path.join(temporary, "output");
      const runtime = [
        "package.json", "dist/main/main/launcher.js", "dist/main/preload/index.js",
        "dist/main/main/appSkills/accord/SKILL.md", "dist/renderer/index.html",
        "dist/renderer/assets/app.js", "node_modules/update-electron-app/dist/index.js",
        "node_modules/example/lib/index.js", "node_modules/example/assets/icon.png",
        "node_modules/@scope/example/package.json"
      ];
      const workspace = [
        ".scratch/corpus.sqlite3", ".worktrees/task/out/Nested.app/app.asar",
        ".worktrees/task/node_modules/electron/binary", ".qa-user-data/settings.json",
        ".env.local", ".env.production", "future-local-folder/private.txt",
        "dist-backup/chat.sqlite3", "node_modules-backup/data", "package.json.bak",
        "docs/example.md", "assets/icon.icns", "src/main/main.ts",
        "dist/renderer-tests/example.js", "dist/main/main/services/chat.test.js"
      ];
      for (const file of [...runtime, ...workspace, "node_modules/node-pty/package.json"]) {
        await mkdir(path.dirname(path.join(input, file)), { recursive: true });
        await writeFile(path.join(input, file), "fixture");
      }
      const options = { ...configFor(platform), dir: input, out: output, prune: false };
      populateIgnoredPaths(options);
      await cp(input, output, { recursive: true, filter: userPathFilter(options) });
      for (const file of runtime) {
        assert.equal(await readFile(path.join(output, file), "utf8"), "fixture", file);
      }
      for (const file of workspace) {
        await assert.rejects(readFile(path.join(output, file)), { code: "ENOENT" }, file);
      }
      assert.deepEqual((await readdir(output)).sort(), ["dist", "node_modules", "package.json"]);
      if (platform === "win32") {
        assert.equal(await readFile(path.join(output, "node_modules/node-pty/package.json"), "utf8"), "fixture");
      } else {
        await assert.rejects(readFile(path.join(output, "node_modules/node-pty/package.json")), { code: "ENOENT" });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
