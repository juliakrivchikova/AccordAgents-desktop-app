// Bundles the relay worker to the module format workerd loads, so tests can
// run it under the Miniflare API. `wrangler dev` bundles the same source the
// same way; this exists only because the Miniflare API takes a script rather
// than a wrangler config.
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outdir = path.join(repoRoot, "dist/relay-worker");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, "cloudflare/relay/src/index.ts")],
  outfile: path.join(outdir, "index.mjs"),
  bundle: true,
  format: "esm",
  target: "esnext",
  platform: "neutral",
  external: ["cloudflare:workers", "node:*"],
  logLevel: "warning"
});
