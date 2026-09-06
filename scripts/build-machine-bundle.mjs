// Bundles the headless machine runtime (src/machine/main.ts) into one Node
// file so a Linux machine needs only Node, the sqlite3 CLI, the provider CLIs,
// this bundle, and its enrollment file. Electron never enters the bundle: the
// runtime composes the same services through src/main/platform.ts.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
await cp(path.join(repoRoot, "src/main/appSkills"), path.join(outdir, "appSkills"), { recursive: true });
await writeFile(path.join(outdir, "README.md"), `# AccordAgents machine runtime ${pkg.version}

Install on a Linux computer that will host chat members:

1. Install Node 20+, the sqlite3 CLI, git, and the provider CLIs you use (codex, claude); log the CLIs in on this computer.
2. Copy this directory somewhere stable (for example ~/accordagents-machine) and run \`npm install --omit=dev\` inside it.
3. In the desktop app, Settings > General > Machines > Add machine, copy the enrollment and save it as ~/accordagents-machine/enrollment.json (it carries the relay key; keep it private).
4. Start the runtime: \`node accordagents-machine.cjs --enrollment enrollment.json --user-data ~/.accordagents/machine --name <machine name>\`.
   Keep it running with systemd (see docs/machines/03-machine-runtime.md in the repository).

The runtime keeps its own data under the user-data directory: chats it hosts, provider sessions, settings copied from the desktop, and the machine secret key.
`, "utf8");
console.log(`machine bundle written to ${outdir}; external dependencies: ${Object.keys(dependencies).join(", ") || "(none)"}`);
