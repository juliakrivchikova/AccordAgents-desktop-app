// Bundles the headless machine runtime (src/machine/main.ts) into one Node
// file so a Linux machine needs only Node, the sqlite3 CLI, the provider CLIs,
// this bundle, and its enrollment file. Electron never enters the bundle: the
// runtime composes the same services through src/main/platform.ts.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outdir = path.join(repoRoot, "dist", "machine");
const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

// Native or platform-specific packages stay external and are installed on the
// machine from the generated package.json; everything else is bundled.
const externals = ["electron", "node-pty", "@aws-sdk/*", "@smithy/*"];

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [path.join(repoRoot, "src/machine/main.ts")],
  outfile: path.join(outdir, "accordagents-machine.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node20"],
  sourcemap: true,
  external: externals,
  logLevel: "warning",
  banner: { js: "#!/usr/bin/env node" },
  metafile: true
});

// The provider supervisor has an independent OS lifetime and must remain an
// executable beside the main bundle (not inline in its module graph).
await build({
  entryPoints: [path.join(repoRoot, "src/main/services/nativeProcessSupervisor.ts")],
  outfile: path.join(outdir, "nativeProcessSupervisor.cjs"),
  bundle: true, format: "cjs", platform: "node", target: ["node20"],
  logLevel: "warning"
});

// Packages the bundle still requires at runtime (only the externals that are
// actually referenced) become the machine's dependencies.
const referenced = new Set();
for (const input of Object.values(result.metafile.inputs)) {
  for (const imp of input.imports ?? []) {
    if (imp.external) {
      const name = imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0];
      if (name !== "electron" && !name.startsWith("node:")) {
        referenced.add(name);
      }
    }
  }
}
const dependencies = {};
for (const name of [...referenced].sort()) {
  const version = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  if (version) {
    dependencies[name] = version;
  }
}
await writeFile(path.join(outdir, "package.json"), `${JSON.stringify({
  name: "accordagents-machine",
  version: pkg.version,
  private: true,
  description: "AccordAgents machine runtime: hosts chat members without a window and talks to a desktop through the relay.",
  bin: { "accordagents-machine": "./accordagents-machine.cjs" },
  engines: { node: ">=20" },
  dependencies
}, null, 2)}\n`, "utf8");
// The exact packages the machine installs, each with its integrity hash: the
// versions this repository's lockfile has (the ones its tests ran with),
// pruned to what the runtime needs, shipped as npm-shrinkwrap.json and
// installed with `npm ci`. Without it a machine resolved caret ranges at
// install time, so a malicious release of any package in the tree would run
// on every machine installed or upgraded after it.
await copyFile(path.join(repoRoot, "package-lock.json"), path.join(outdir, "package-lock.json"));
// On Windows npm is usually a .cmd script, which execFile cannot start; under
// `npm run` npm_execpath names npm's own entry point.
const npm = /npm-cli\.js$/.test(process.env.npm_execpath ?? "") ? [process.execPath, process.env.npm_execpath] : ["npm"];
execFileSync(npm[0], [...npm.slice(1), "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: outdir, stdio: ["ignore", "ignore", "inherit"] });
const lock = JSON.parse(await readFile(path.join(outdir, "package-lock.json"), "utf8"));
for (const [where, entry] of Object.entries(lock.packages ?? {})) {
  if (where && !entry.link && !entry.integrity) throw new Error(`The machine's lockfile has no integrity hash for ${where}.`);
}
await rename(path.join(outdir, "package-lock.json"), path.join(outdir, "npm-shrinkwrap.json"));
await cp(path.join(repoRoot, "src/main/appSkills"), path.join(outdir, "appSkills"), { recursive: true });
// A release that carries this file understands `--maintenance`. An older
// release does not, and running `node <old runtime> --maintenance ...` would
// not run the wrapped command at all: the old argument parser ignores unknown
// flags and would start a SECOND machine runtime on that user-data directory.
// The wrapper checks for this marker instead of assuming.
await writeFile(path.join(outdir, "maintenance-v1"), "1\n", "utf8");
await writeFile(path.join(outdir, "README.md"), `# AccordAgents machine runtime ${pkg.version}

Install on a Linux computer that will host chat members:

1. Install Node 20+, the sqlite3 CLI, git, and the provider CLIs you use (codex, claude); log the CLIs in on this computer.
2. Copy this directory somewhere stable (for example ~/accordagents-machine) and run \`npm ci --omit=dev\` inside it (it installs exactly the versions in npm-shrinkwrap.json).
3. In the desktop app, Settings > General > Machines > Add machine, copy the enrollment and save it as ~/accordagents-machine/enrollment.json (it carries the relay key; keep it private).
4. Start the runtime: \`node accordagents-machine.cjs --enrollment enrollment.json --user-data ~/.accordagents/machine --name <machine name>\`.
   Keep it running with systemd (see docs/machines/03-machine-runtime.md in the repository).

The runtime keeps its own data under the user-data directory: chats it hosts, provider sessions, settings copied from the desktop, and the machine secret key.
`, "utf8");

// The payload manifest. A desktop that ships this bundle inside its own
// application resources cannot rebuild it, so it verifies it instead: every
// file listed here must be present with exactly this size and hash, and no
// other file may be there. A payload truncated by a partial download or a
// half-finished copy is then refused before it reaches a machine, rather than
// installed as a runtime that cannot start.
//
// payload.json itself is excluded from the listing (it cannot contain its own
// hash) and from the bundle digest the installer computes, so adding it does
// not change how a release is identified.
const PAYLOAD_MANIFEST = "payload.json";
async function manifestEntries(dir, prefix = "") {
  const entries = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === "node_modules" || (!prefix && entry.name === PAYLOAD_MANIFEST)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...await manifestEntries(full, relative));
    } else if (entry.isFile()) {
      const contents = await readFile(full);
      entries.push({ path: relative, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") });
    } else {
      // `rsync -a` would copy a symbolic link to the machine as a link, so a
      // bundle that merely skipped one would ship content the manifest never
      // described. Fail the build instead of producing such a payload.
      throw new Error(
        `The machine bundle would contain ${relative}, which is not a regular file or directory. ` +
        "A payload may only contain regular files and directories; remove it from the sources copied into dist/machine."
      );
    }
  }
  return entries;
}
const files = await manifestEntries(outdir);
await writeFile(path.join(outdir, PAYLOAD_MANIFEST), `${JSON.stringify({
  manifestVersion: 1,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  files
}, null, 2)}\n`, "utf8");

const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
console.log(`machine bundle written to ${outdir}; ${files.length} files, ${totalBytes} bytes; external dependencies: ${Object.keys(dependencies).join(", ") || "(none)"}`);
