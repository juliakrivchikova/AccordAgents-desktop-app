import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const outdir = path.join(process.cwd(), "dist", "renderer-tests-chat-progress");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    "chat-activity-rendering.test": path.join(
      process.cwd(),
      "src/renderer/components/chat/chat-activity-rendering.test.tsx"
    ),
    "chat-progress-rendering.test": path.join(
      process.cwd(),
      "src/renderer/components/chat/chat-progress-rendering.test.tsx"
    )
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  loader: {
    ".png": "dataurl",
    ".jpg": "dataurl",
    ".jpeg": "dataurl",
    ".webp": "dataurl"
  },
  define: {
    "import.meta.env": JSON.stringify({ DEV: false, VITE_ACCORD_AGENTS_SHOW_SYSTEM_MESSAGES: "0" })
  },
  logLevel: "warning"
});
