import { mkdir } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const sourceRoot = path.join(process.cwd(), "src");
const outdir = path.join(process.cwd(), "dist", "renderer-tests");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [
    "renderer/components/chat/chat-composer-mention-token.test.ts",
    "renderer/components/chat/chat-composer-plugin-token.test.ts",
    "renderer/components/artifacts/artifact-drafts.test.tsx",
    "renderer/components/artifacts/artifact-navigation.test.ts",
    "renderer/components/chat/chat-progress-rendering.test.tsx",
    "renderer/components/chat/cli-readiness-setup-panel.test.tsx",
    "renderer/components/chat/chat-mobile-pairing-revoke.test.tsx",
    "renderer/components/settings/aws-worker-panel.test.tsx"
  ].map((entry) => path.join(sourceRoot, entry)),
  alias: { "@": sourceRoot },
  outbase: sourceRoot,
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
