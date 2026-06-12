import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Capture the raw request body so Svix-signed webhooks (AgentMail) can be
// verified byte-for-byte; the parsed JSON body is still produced as usual.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Optionally serve the built web UI from this same server so a single process
// delivers both the API and the front end (the "beginner" one-command mode set
// up by run.sh). Gated on CONTEXTOS_WEB_DIR so it never activates on Replit,
// where the web is its own artifact served by a separate workflow.
const webDir = process.env["CONTEXTOS_WEB_DIR"];
if (webDir && fs.existsSync(path.join(webDir, "index.html"))) {
  app.use(express.static(webDir));
  // SPA fallback: any non-API GET that didn't match a static file serves
  // index.html so client-side routes (e.g. /chat) load on a fresh request.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(webDir, "index.html"), (err) => {
      if (err) next();
    });
  });
  logger.info({ webDir }, "Serving web UI from API server");
}

export default app;
