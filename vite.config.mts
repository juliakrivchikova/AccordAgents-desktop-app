import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  root: ".",
  base: "./",
  build: {
    // The renderer runs only in this app's Electron (31: Chromium 126). Vite's
    // default target rewrites newer syntax for 2020 browsers, and its esbuild
    // then drops a variable it still assigns: in xterm's requestMode that
    // stopped a terminal for good as soon as a program asked it for a mode
    // (the Codex CLI does when it starts).
    target: "chrome126",
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
            return "react-vendor";
          }
          if (
            id.includes("/radix-ui/") ||
            id.includes("/lucide-react/") ||
            id.includes("/@tanstack/react-virtual/") ||
            id.includes("/cmdk/") ||
            id.includes("/next-themes/") ||
            id.includes("/sonner/") ||
            id.includes("/class-variance-authority/") ||
            id.includes("/clsx/") ||
            id.includes("/tailwind-merge/")
          ) {
            return "ui-vendor";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
