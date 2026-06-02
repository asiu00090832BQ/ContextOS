import type { Request, Response, NextFunction } from "express";
import { getContext } from "../lib/context";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId: string;
      userId: string;
    }
  }
}

export async function tenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const ctx = await getContext();
  req.tenantId = ctx.tenant.id;
  req.userId = ctx.user.id;
  next();
}
