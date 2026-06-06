import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, deploymentTargetsTable } from "@workspace/db";
import { ListDeploymentTargetsResponse } from "@workspace/api-zod";
import { serializeDeploymentTarget } from "../lib/serialize";

const router: IRouter = Router();

router.get("/deployment-targets", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(deploymentTargetsTable)
    .where(eq(deploymentTargetsTable.tenantId, req.tenantId))
    .orderBy(desc(deploymentTargetsTable.createdAt));
  res.json(
    ListDeploymentTargetsResponse.parse(rows.map(serializeDeploymentTarget)),
  );
});

export default router;
