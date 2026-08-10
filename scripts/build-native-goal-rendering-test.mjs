import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const outdir = path.join(process.cwd(), "dist", "renderer-tests-native-goal");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    "native-goal-rendering.test": path.join(
      process.cwd(),
      "src/renderer/components/chat/native-goal-rendering.test.ts"
    )
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning"
});
