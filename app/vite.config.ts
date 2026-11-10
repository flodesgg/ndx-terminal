import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Browser mode (SPEC §3): hands the backend port + launch token to the page at runtime, so the
 * token is never in the URL or the JS bundle (SPEC §1.5). Dev server only; answers same-origin
 * fetches only (Sec-Fetch-Site), and Vite's own Host check blocks DNS rebinding.
 */
function ndxBackendInfo(): Plugin {
  return {
    name: "ndx-backend-info",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__ndx/backend", (req, res) => {
        const port = Number(process.env.NDX_DEV_PORT);
        const token = process.env.NDX_DEV_TOKEN ?? "";
        res.setHeader("cache-control", "no-store");
        if (req.headers["sec-fetch-site"] !== "same-origin") {
          res.statusCode = 403;
          res.end();
          return;
        }
        if (!port || token.length < 32) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "backend not started; run `make dev`" }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ port, token }));
      });
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), ndxBackendInfo()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      "@brand": fileURLToPath(new URL("../brand.json", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: { allow: [".."] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari16",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
