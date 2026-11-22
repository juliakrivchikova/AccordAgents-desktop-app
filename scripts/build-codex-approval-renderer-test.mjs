import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

// Bundled as ESM like the other renderer tests: the icon package ships its
// CommonJS build as a .js file inside a "type": "module" package, which a
// CommonJS test cannot require.
const outdir = path.join(process.cwd(), "dist", "codex-approval-renderer-test");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    "chat-codex-approval-rendering.test": path.join(
      process.cwd(),
      "src/renderer/components/chat/chat-codex-approval-rendering.test.tsx"
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
