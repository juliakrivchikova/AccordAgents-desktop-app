// Bundles the hub (src/hub/main.ts), the User's own always-on server, into
// one Node file. The server needs only Node, the sqlite3 CLI and this bundle;
// nothing is installed from npm on it.
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outdir = path.join(repoRoot, "dist", "hub");
const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [path.join(repoRoot, "src/hub/main.ts")],
  outfile: path.join(outdir, "accordagents-hub.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node20"],
  sourcemap: true,
  // `electron` is only ever required behind a check that the process is
  // Electron; `ws` optional native helpers are not needed.
  external: ["electron", "bufferutil", "utf-8-validate"],
  define: { __HUB_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
  banner: { js: "#!/usr/bin/env node" },
  metafile: true
});

const externalImports = new Set();
for (const input of Object.values(result.metafile.inputs)) {
  for (const imp of input.imports ?? []) if (imp.external && !imp.path.startsWith("node:")) externalImports.add(imp.path);
}
await writeFile(path.join(outdir, "package.json"), `${JSON.stringify({
  name: "accordagents-hub",
  version: pkg.version,
  private: true,
  description: "AccordAgents hub: the User's own server for chats, search and the phone.",
  bin: { "accordagents-hub": "./accordagents-hub.cjs" },
  engines: { node: ">=20" }
}, null, 2)}\n`, "utf8");
console.log(`hub bundle written to ${outdir}; external imports: ${[...externalImports].join(", ") || "none"}`);
