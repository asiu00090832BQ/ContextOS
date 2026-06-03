import type { Request, Response, NextFunction } from "express";
import { getContext } from "../lib/context";
import { bearerFromHeader, verifyApiKey } from "../lib/apiKeys";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId: string;
      userId: string;
      authVia: "session" | "api_key";
      apiKeyId?: string;
    }
  }
}

/**
 * Resolve the active tenant for a request. A bearer API key (sent by an
 * external AI/script on another computer) authenticates as its tenant; an
 * invalid/revoked/expired key is rejected with 401. With no bearer token we
 * fall back to the auto-bootstrapped single owner so the local web UI keeps
 * working without a key.
 */
export async function tenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerFromHeader(req.headers.authorization);
  if (token) {
    const key = await verifyApiKey(token);
    if (!key) {
      res.status(401).json({ error: "Invalid, revoked, or expired API key." });
      return;
    }
    const ctx = await getContext();
    req.tenantId = key.tenantId;
    req.userId = ctx.user.id;
    req.authVia = "api_key";
    req.apiKeyId = key.id;
    next();
    return;
  }
  const ctx = await getContext();
  req.tenantId = ctx.tenant.id;
  req.userId = ctx.user.id;
  req.authVia = "session";
  next();
}

/**
 * Guard for remotely-exposed surfaces (REST command API + MCP server). These
 * must be reached with a real API key — the owner session fallback is only for
 * the local web UI, so we reject anything that resolved via "session" here.
 */
export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.authVia !== "api_key") {
    res
      .status(401)
      .json({ error: "An API key is required. Send Authorization: Bearer <key>." });
    return;
  }
  next();
}
