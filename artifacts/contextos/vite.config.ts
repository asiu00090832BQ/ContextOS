import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const isDev = process.env.NODE_ENV !== "production";

// Pick the web port without ever crashing on a missing var:
//   WEB_PORT  -> explicit override (use this to avoid colliding with the API
//                server's PORT, e.g. 8080, when both run from the same shell)
//   PORT      -> injected by the Replit workflow / most hosts
//   5173      -> local default
const rawPort = process.env.WEB_PORT ?? process.env.PORT ?? "5173";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid port value: "${rawPort}"`);
}

// Replit's workflow injects BASE_PATH for path-based routing; default to root
// for standalone/local runs.
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Dev only: forward the web app's relative /api calls to the local API
    // server. Harmless on Replit, where the platform proxy already routes /api
    // (those requests never reach Vite).
    proxy: isDev
      ? {
          "/api": {
            target: process.env.API_PROXY_TARGET ?? "http://localhost:8080",
            changeOrigin: true,
          },
        }
      : undefined,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
