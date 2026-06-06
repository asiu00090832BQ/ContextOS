import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { tenantContext } from "../middlewares/tenant";
import contextRouter from "./context";
import tenantsRouter from "./tenants";
import principalsRouter from "./principals";
import contextResourcesRouter from "./contextResources";
import linkedAccountsRouter from "./linkedAccounts";
import adaptersRouter from "./adapters";
import constructedServersRouter from "./constructedServers";
import deploymentTargetsRouter from "./deploymentTargets";
import intentsRouter from "./intents";
import runsRouter from "./runs";
import agentsRouter from "./agents";
import botRouter from "./bot";
import conversationsRouter from "./conversations";
import apiKeysRouter from "./apiKeys";
import commandsRouter from "./commands";
import mcpRouter from "./mcp";
import observabilityRouter from "./observability";
import { telegramWebhookRouter, telegramAdminRouter } from "./telegram";

const router: IRouter = Router();

// Health stays unauthenticated and outside tenant scope.
router.use(healthRouter);

// The Telegram webhook must stay outside tenant context / API-key auth — it is
// authenticated solely by the Telegram secret-token header.
router.use(telegramWebhookRouter);

// All domain routers are tenant-scoped (single auto-bootstrapped owner + tenant).
router.use(tenantContext);
router.use(contextRouter);
router.use(tenantsRouter);
router.use(principalsRouter);
router.use(contextResourcesRouter);
router.use(linkedAccountsRouter);
router.use(adaptersRouter);
router.use(constructedServersRouter);
router.use(deploymentTargetsRouter);
router.use(intentsRouter);
router.use(runsRouter);
router.use(agentsRouter);
router.use(botRouter);
router.use(conversationsRouter);
router.use(apiKeysRouter);
router.use(commandsRouter);
router.use(mcpRouter);
router.use(observabilityRouter);
router.use(telegramAdminRouter);

export default router;
