import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const outdir = path.join(process.cwd(), "dist", "renderer-tests-new-chat");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    "new-chat-screen.test": path.join(process.cwd(), "src/renderer/components/chat/new-chat-screen.test.tsx"),
    "use-chat-actions.test": path.join(process.cwd(), "src/renderer/app/use-chat-actions.test.tsx")
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
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
