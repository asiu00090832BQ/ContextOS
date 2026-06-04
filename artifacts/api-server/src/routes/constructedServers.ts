import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { db, adaptersTable, capabilitiesTable } from "@workspace/db";
import {
  CreateConstructedServerBody,
  ImportOpenApiParams,
  ImportOpenApiBody,
  AddWebToolParams,
  AddWebToolBody,
  SetConstructedServerAuthParams,
  SetConstructedServerAuthBody,
  DeleteCapabilityParams,
  InvokeCapabilityParams,
  InvokeCapabilityBody,
  InvokeCapabilityResponse,
  GetAdapterResponse,
} from "@workspace/api-zod";
import { serializeAdapterDetail, serializeCapability } from "../lib/serialize";
import {
  openApiToTools,
  parseRecipe,
  safeFetch,
  type AuthType,
} from "../lib/webTools";
import { executeCapabilityRow } from "../lib/capabilityExec";
import { putSecret, deleteSecret } from "../lib/secretStore";

const router: IRouter = Router();

type ActionKind =
  | "read"
  | "list"
  | "analysis"
  | "create"
  | "update"
  | "destructive"
  | "custom";
type RiskTier = "L1" | "L2" | "L3" | "L4";
type CapabilityType = "tool" | "resource" | "prompt";

async function loadConstructedAdapter(tenantId: string, id: string) {
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(and(eq(adaptersTable.id, id), eq(adaptersTable.tenantId, tenantId)));
  return adapter;
}

async function respondAdapterDetail(
  res: import("express").Response,
  adapterId: string,
  status = 200,
): Promise<void> {
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(eq(adaptersTable.id, adapterId));
  const caps = await db
    .select()
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.adapterId, adapterId));
  res
    .status(status)
    .json(GetAdapterResponse.parse(serializeAdapterDetail(adapter, caps)));
}

// Create a constructed MCP server (an adapter with transport=constructed).
router.post("/constructed-servers", async (req, res): Promise<void> => {
  const parsed = CreateConstructedServerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(adaptersTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      transport: "constructed",
      endpointUrl: parsed.data.baseUrl,
      status: "active",
      metadataJson: {
        authType: "none",
        allowPrivateNetwork: parsed.data.allowPrivateNetwork === true,
        createdVia: "ui",
      },
    })
    .returning();
  await respondAdapterDetail(res, row.id, 201);
});

// Import an OpenAPI / Swagger spec and create capabilities for each operation.
router.post(
  "/constructed-servers/:id/import-openapi",
  async (req, res): Promise<void> => {
    const params = ImportOpenApiParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ImportOpenApiBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const adapter = await loadConstructedAdapter(req.tenantId, params.data.id);
    if (!adapter) {
      res.status(404).json({ error: "Constructed server not found" });
      return;
    }

    const allowPrivate =
      (adapter.metadataJson as Record<string, unknown> | null)
        ?.allowPrivateNetwork === true;

    let specText = parsed.data.specText ?? "";
    if (!specText && parsed.data.specUrl) {
      try {
        const r = await safeFetch(
          parsed.data.specUrl,
          {
            headers: { accept: "application/json, application/yaml, text/yaml" },
            timeoutMs: 20_000,
          },
          allowPrivate,
        );
        if (!r.ok) {
          res
            .status(400)
            .json({ error: `Failed to fetch spec: HTTP ${r.status}` });
          return;
        }
        specText = await r.text();
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Failed to fetch spec.",
        });
        return;
      }
    }
    if (!specText) {
      res.status(400).json({ error: "Provide specUrl or specText." });
      return;
    }

    let doc: Record<string, unknown>;
    try {
      doc =
        specText.trim().startsWith("{") || specText.trim().startsWith("[")
          ? JSON.parse(specText)
          : (parseYaml(specText) as Record<string, unknown>);
    } catch (err) {
      res.status(400).json({
        error: `Could not parse spec: ${err instanceof Error ? err.message : "invalid format"}`,
      });
      return;
    }

    const parsedSpec = openApiToTools(doc);
    if (parsedSpec.tools.length === 0) {
      res
        .status(400)
        .json({ error: "No operations found in the provided spec." });
      return;
    }

    const baseUrl =
      parsed.data.baseUrl ?? parsedSpec.baseUrl ?? adapter.endpointUrl;

    if (parsed.data.replaceExisting) {
      await db
        .delete(capabilitiesTable)
        .where(eq(capabilitiesTable.adapterId, adapter.id));
    }

    await db.insert(capabilitiesTable).values(
      parsedSpec.tools.map((t) => ({
        tenantId: req.tenantId,
        adapterId: adapter.id,
        type: "tool" as CapabilityType,
        name: t.name,
        description: t.description,
        riskTier: t.riskTier as RiskTier,
        actionKind: t.actionKind as ActionKind,
        humanReviewRequired: t.humanReviewRequired,
        inputSchemaJson: t.inputSchema,
        executionJson: t.recipe as unknown as Record<string, unknown>,
      })),
    );

    await db
      .update(adaptersTable)
      .set({
        endpointUrl: baseUrl,
        protocolVersion: "constructed/1.0",
        lastDiscoveredAt: new Date(),
        ...(parsedSpec.title
          ? {
              metadataJson: {
                ...((adapter.metadataJson as Record<string, unknown>) ?? {}),
                sourceTitle: parsedSpec.title,
              },
            }
          : {}),
      })
      .where(eq(adaptersTable.id, adapter.id));

    await respondAdapterDetail(res, adapter.id, 200);
  },
);

// Add a single hand-built tool (HTTP or browser) to a constructed server.
router.post(
  "/constructed-servers/:id/tools",
  async (req, res): Promise<void> => {
    const params = AddWebToolParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = AddWebToolBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const adapter = await loadConstructedAdapter(req.tenantId, params.data.id);
    if (!adapter) {
      res.status(404).json({ error: "Constructed server not found" });
      return;
    }
    const recipe = parseRecipe(parsed.data.recipe);
    if (!recipe) {
      res.status(400).json({
        error:
          "Invalid recipe. Provide an http recipe (method, pathTemplate) or a browser recipe (startUrl, steps).",
      });
      return;
    }
    if (recipe.kind !== parsed.data.kind) {
      res
        .status(400)
        .json({ error: `Recipe kind does not match declared kind "${parsed.data.kind}".` });
      return;
    }
    const [row] = await db
      .insert(capabilitiesTable)
      .values({
        tenantId: req.tenantId,
        adapterId: adapter.id,
        type: "tool",
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        riskTier: (parsed.data.riskTier as RiskTier | undefined) ?? "L2",
        actionKind: (parsed.data.actionKind as ActionKind | undefined) ?? "custom",
        humanReviewRequired: parsed.data.humanReviewRequired === true,
        inputSchemaJson:
          (parsed.data.inputSchema as Record<string, unknown> | undefined) ?? {
            type: "object",
            properties: {},
          },
        executionJson: recipe as unknown as Record<string, unknown>,
      })
      .returning();
    res.status(201).json(serializeCapability(row));
  },
);

// Configure authentication for a constructed server (secret kept out of the DB).
router.put(
  "/constructed-servers/:id/auth",
  async (req, res): Promise<void> => {
    const params = SetConstructedServerAuthParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SetConstructedServerAuthBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const adapter = await loadConstructedAdapter(req.tenantId, params.data.id);
    if (!adapter) {
      res.status(404).json({ error: "Constructed server not found" });
      return;
    }
    const authType = parsed.data.type as AuthType;
    let credentialRef = adapter.credentialRef;
    if (authType === "none") {
      if (credentialRef) {
        deleteSecret(credentialRef);
        credentialRef = null;
      }
    } else if (parsed.data.secret) {
      credentialRef = putSecret(parsed.data.secret, credentialRef);
    }
    await db
      .update(adaptersTable)
      .set({
        credentialRef,
        metadataJson: {
          ...((adapter.metadataJson as Record<string, unknown>) ?? {}),
          authType,
          authName: parsed.data.name ?? null,
        },
      })
      .where(eq(adaptersTable.id, adapter.id));
    await respondAdapterDetail(res, adapter.id, 200);
  },
);

// Delete a single tool (capability).
router.delete("/capabilities/:id", async (req, res): Promise<void> => {
  const params = DeleteCapabilityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(capabilitiesTable)
    .where(
      and(
        eq(capabilitiesTable.id, params.data.id),
        eq(capabilitiesTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Capability not found" });
    return;
  }
  res.sendStatus(204);
});

// Invoke a tool live (used by the UI tester and ad-hoc execution).
router.post("/capabilities/:id/invoke", async (req, res): Promise<void> => {
  const params = InvokeCapabilityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = InvokeCapabilityBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [cap] = await db
    .select()
    .from(capabilitiesTable)
    .where(
      and(
        eq(capabilitiesTable.id, params.data.id),
        eq(capabilitiesTable.tenantId, req.tenantId),
      ),
    );
  if (!cap) {
    res.status(404).json({ error: "Capability not found" });
    return;
  }
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(eq(adaptersTable.id, cap.adapterId));
  if (!adapter) {
    res.status(404).json({ error: "Owning server not found" });
    return;
  }
  const result = await executeCapabilityRow(
    cap,
    adapter,
    (parsed.data.arguments as Record<string, unknown> | undefined) ?? {},
  );
  res.json(
    InvokeCapabilityResponse.parse({
      ok: result.ok,
      kind: result.kind,
      status: result.status ?? null,
      durationMs: result.durationMs,
      ...(result.body !== undefined ? { body: result.body } : {}),
      ...(result.extracted !== undefined
        ? { extracted: result.extracted }
        : {}),
      error: result.error ?? null,
    }),
  );
});

export default router;
