import { defineConfig } from "drizzle-kit";
import path from "path";

// Load a local root `.env` (for GitHub-clone setups) so `pnpm --filter
// @workspace/db run push` picks up DATABASE_URL without manual exports. Values
// already present in the environment (e.g. Replit-injected secrets) take
// precedence, and a missing file is ignored.
try {
  process.loadEnvFile(path.join(__dirname, "../../.env"));
} catch {
  // No root .env present — rely on the existing environment.
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
