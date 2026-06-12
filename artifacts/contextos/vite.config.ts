import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const isReplit = process.env.REPL_ID !== undefined;

// On Replit, the platform injects a per-artifact PORT that must be used.
// Standalone, ignore any PORT meant for the API server (e.g. PORT=8080 from
// .env) and use a dedicated WEB_PORT or a local default to avoid a collision.
const rawPort = isReplit ? process.env.PORT : process.env.WEB_PORT ?? "5173";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid port value: "${rawPort}"`);
}

// On Replit the platform injects BASE_PATH; standalone defaults to root.
const basePath = process.env.BASE_PATH ?? (isReplit ? undefined : "/");

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

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
    // Standalone dev: forward the web app's relative /api calls to the local
    // API server. On Replit the platform proxy handles /api routing, so this
    // is left off there.
    proxy: isReplit
      ? undefined
      : {
          "/api": {
            target: process.env.API_PROXY_TARGET ?? "http://localhost:8080",
            changeOrigin: true,
          },
        },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
