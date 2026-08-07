import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = process.cwd();
const outdir = path.join(root, "dist", "renderer-tests");
const entries = [
  "src/renderer/components/chat/chat-composer-mention-token.test.ts",
  "src/renderer/components/chat/chat-composer-plugin-token.test.ts",
  "src/renderer/components/artifacts/artifact-drafts.test.tsx",
  "src/renderer/components/artifacts/artifact-navigation.test.ts",
  "src/renderer/components/chat/chat-progress-rendering.test.tsx",
  "src/renderer/components/chat/cli-readiness-setup-panel.test.tsx",
  "src/renderer/components/settings/aws-worker-panel.test.tsx"
];

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: entries.map((entry) => path.join(root, entry)),
  outbase: path.join(root, "src"),
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  jsx: "automatic",
  tsconfig: path.join(root, "tsconfig.renderer.json"),
  loader: {
    ".css": "empty",
    ".jpeg": "dataurl",
    ".jpg": "dataurl",
    ".png": "dataurl",
    ".svg": "dataurl",
    ".webp": "dataurl"
  },
  define: {
    "import.meta.url": JSON.stringify("file:///accordagents-renderer-test.js"),
    "import.meta.env": JSON.stringify({
      DEV: false,
      VITE_ACCORD_AGENTS_SHOW_SYSTEM_MESSAGES: "0"
    })
  },
  logLevel: "warning"
});
