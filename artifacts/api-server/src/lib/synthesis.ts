import type { InferInsertModel } from "drizzle-orm";
import {
  synthesizedCapabilitiesTable,
  integrationTestsTable,
} from "@workspace/db";

type SynthCapSeed = Omit<
  InferInsertModel<typeof synthesizedCapabilitiesTable>,
  "tenantId" | "generatedServerId"
>;
type TestSeed = Omit<
  InferInsertModel<typeof integrationTestsTable>,
  "tenantId" | "generatedServerId"
>;

export interface NormalizedSpec {
  service: string;
  operations: {
    operationId: string;
    method: string;
    path: string;
    summary: string;
    mutating: boolean;
  }[];
}

/**
 * Analyze a blueprint source spec into a normalized operation list.
 * Deterministic demo analyzer — derives a plausible operation catalog.
 */
export function analyzeBlueprint(
  serviceName: string,
  sourceSpec: string | null,
): { normalized: NormalizedSpec; operationCount: number; confidence: number } {
  const ops: NormalizedSpec["operations"] = [];
  const verbs = [
    { method: "GET", name: "list", mutating: false },
    { method: "GET", name: "get", mutating: false },
    { method: "POST", name: "create", mutating: true },
    { method: "PATCH", name: "update", mutating: true },
    { method: "DELETE", name: "delete", mutating: true },
  ];
  const resource = serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  for (const v of verbs) {
    ops.push({
      operationId: `${v.name}_${resource}`,
      method: v.method,
      path: v.name === "list" || v.name === "create" ? `/${resource}` : `/${resource}/{id}`,
      summary: `${v.name} ${resource}`,
      mutating: v.mutating,
    });
  }
  const confidence = sourceSpec && sourceSpec.length > 40 ? 92 : 74;
  return {
    normalized: { service: serviceName, operations: ops },
    operationCount: ops.length,
    confidence,
  };
}

function riskForMethod(method: string): "L1" | "L2" | "L3" | "L4" {
  if (method === "DELETE") return "L4";
  if (method === "POST" || method === "PATCH" || method === "PUT") return "L3";
  return "L1";
}

type ActionKind =
  | "read"
  | "list"
  | "analysis"
  | "create"
  | "update"
  | "destructive"
  | "custom";

function actionKindForMethod(method: string): ActionKind {
  switch (method) {
    case "DELETE":
      return "destructive";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    default:
      return "read";
  }
}

const MUTATING_KINDS: ActionKind[] = ["create", "update", "destructive"];

/** Synthesize capabilities + server code + tests from a normalized spec. */
export function synthesizeServer(normalized: NormalizedSpec): {
  capabilities: SynthCapSeed[];
  tests: TestSeed[];
  serverCode: string;
  securityReview: Record<string, unknown>;
} {
  const capabilities: SynthCapSeed[] = normalized.operations.map((op) => {
    const risk = riskForMethod(op.method);
    return {
      type: "tool",
      name: op.operationId,
      description: op.summary,
      sourceOperation: `${op.method} ${op.path}`,
      httpMethod: op.method,
      actionKind: actionKindForMethod(op.method),
      riskTier: risk,
      humanReviewRequired: risk === "L3" || risk === "L4",
      inputSchemaJson: {
        type: "object",
        properties: op.path.includes("{id}")
          ? { id: { type: "string" } }
          : { query: { type: "string" } },
      },
    };
  });

  const tests: TestSeed[] = capabilities.map((c) => ({
    name: `${c.name} contract`,
    status: "passed",
    assertion: `tool ${c.name} returns a schema-valid response`,
    durationMs: 12 + (c.name.length % 40),
    output: "assertion passed",
  }));

  const serverCode = [
    `// Auto-synthesized MCP server for ${normalized.service}`,
    `import { McpServer } from "@modelcontextprotocol/sdk";`,
    ``,
    `export const server = new McpServer({ name: "${normalized.service}" });`,
    ``,
    ...capabilities.map(
      (c) =>
        `server.tool("${c.name}", /* ${c.sourceOperation} */ async (args) => {\n  // risk: ${c.riskTier}\n  return await call("${c.httpMethod}", args);\n});`,
    ),
  ].join("\n");

  const mutatingCount = capabilities.filter(
    (c) => c.actionKind !== undefined && MUTATING_KINDS.includes(c.actionKind),
  ).length;
  const securityReview = {
    summary: `${capabilities.length} capabilities synthesized; ${mutatingCount} mutating operations gated behind human review.`,
    findings: [
      {
        severity: mutatingCount > 0 ? "medium" : "low",
        title: "Mutating operations require approval",
        detail:
          "Write/delete tools are tagged L3/L4 and will trigger human-in-the-loop approval at run time.",
      },
      {
        severity: "low",
        title: "Input schemas generated",
        detail: "All tools have generated input schemas for argument validation.",
      },
    ],
    passed: true,
  };

  return { capabilities, tests, serverCode, securityReview };
}
