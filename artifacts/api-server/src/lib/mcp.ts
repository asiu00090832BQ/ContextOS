import type { InferInsertModel } from "drizzle-orm";
import { capabilitiesTable } from "@workspace/db";

type CapabilitySeed = Omit<
  InferInsertModel<typeof capabilitiesTable>,
  "tenantId" | "adapterId"
>;

/**
 * Demo MCP adapter client. Simulates discovery + health checks against a demo
 * transport without requiring a live MCP server. Returns deterministic
 * capability catalogs keyed by the adapter name.
 */

const DEMO_CATALOGS: Record<string, CapabilitySeed[]> = {
  default: [
    {
      type: "tool",
      name: "search_documents",
      description: "Full-text search across the connected knowledge base.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
      inputSchemaJson: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchemaJson: {
        type: "object",
        properties: { results: { type: "array" } },
      },
    },
    {
      type: "tool",
      name: "create_record",
      description: "Create a new record in the external system.",
      riskTier: "L3",
      actionKind: "create",
      humanReviewRequired: true,
      inputSchemaJson: {
        type: "object",
        properties: { payload: { type: "object" } },
        required: ["payload"],
      },
    },
    {
      type: "resource",
      name: "account_profile",
      description: "Read-only profile resource for the linked account.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
    },
    {
      type: "prompt",
      name: "summarize_thread",
      description: "Prompt template that summarizes a conversation thread.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
    },
  ],
};

export interface DiscoveryResult {
  protocolVersion: string;
  capabilities: CapabilitySeed[];
  serverInfo: Record<string, unknown>;
}

export async function discoverAdapter(
  adapterName: string,
  endpointUrl: string | null,
): Promise<DiscoveryResult> {
  const catalog = DEMO_CATALOGS.default;
  return {
    protocolVersion: "2025-06-18",
    capabilities: catalog,
    serverInfo: {
      name: adapterName,
      transport: endpointUrl ? "http" : "demo",
      endpoint: endpointUrl ?? "demo://local",
      discoveredAt: new Date().toISOString(),
    },
  };
}

export interface HealthResult {
  healthy: boolean;
  latencyMs: number;
  protocolVersion: string;
  checkedAt: string;
  detail: string;
}

export async function healthCheckAdapter(
  adapterName: string,
): Promise<HealthResult> {
  return {
    healthy: true,
    latencyMs: 20 + (adapterName.length % 30),
    protocolVersion: "2025-06-18",
    checkedAt: new Date().toISOString(),
    detail: "Demo transport reachable; handshake succeeded.",
  };
}
