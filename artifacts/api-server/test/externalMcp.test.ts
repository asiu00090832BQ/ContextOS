import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Integration test for the live external-MCP transport added for screen-control
// servers. Spins up a REAL stub MCP server over HTTP (initialize →
// notifications/initialized → tools/call) and verifies:
//   1. callMcpTool performs the handshake and invokes a tool.
//   2. image content blocks are returned as `media` (not stringified text), with
//      a placeholder line in the text so text-only consumers still see them.
//   3. tool-level isError is surfaced (vs. thrown transport errors).
//   4. toToolExecutionResult passes external media through and leaves every other
//      result stringified exactly as before.
// ---------------------------------------------------------------------------

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let server: http.Server;
let baseUrl: string;

function send(res: http.ServerResponse, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(raw);
}

before(async () => {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const msg = data ? JSON.parse(data) : {};
      const method = msg.method as string | undefined;
      if (!method || method.startsWith("notifications/")) {
        res.writeHead(202).end();
        return;
      }
      if (method === "initialize") {
        res.setHeader("mcp-session-id", "sess-1");
        send(res, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-screen", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "tools/call") {
        const name = msg.params?.name;
        if (name === "screenshot") {
          send(res, {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                { type: "text", text: "Captured screen." },
                { type: "image", mimeType: "image/png", data: PNG_1x1 },
              ],
            },
          });
          return;
        }
        if (name === "boom") {
          send(res, {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: "tool failed internally" }],
              isError: true,
            },
          });
          return;
        }
        send(res, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "ok" }] },
        });
        return;
      }
      send(res, { jsonrpc: "2.0", id: msg.id ?? null, result: {} });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
});

after(() => {
  server.close();
});

describe("callMcpTool (live external MCP transport)", () => {
  it("returns image content blocks as media, not stringified text", async () => {
    const { callMcpTool } = await import("../src/lib/mcp.ts");
    const res = await callMcpTool(baseUrl, "screenshot", {});
    assert.equal(res.isError, false);
    assert.equal(res.media.length, 1);
    assert.equal(res.media[0].kind, "image");
    assert.equal(res.media[0].mimeType, "image/png");
    assert.equal(res.media[0].data, PNG_1x1);
    // The raw base64 must NOT be in the text — only a placeholder line.
    assert.ok(res.text.includes("Captured screen."));
    assert.ok(res.text.includes("[image image/png"));
    assert.ok(!res.text.includes(PNG_1x1));
  });

  it("surfaces tool-level isError", async () => {
    const { callMcpTool } = await import("../src/lib/mcp.ts");
    const res = await callMcpTool(baseUrl, "boom", {});
    assert.equal(res.isError, true);
    assert.ok(res.text.includes("tool failed internally"));
  });
});

describe("toToolExecutionResult", () => {
  it("passes external_mcp media through", async () => {
    const { toToolExecutionResult } = await import("../src/lib/toolChat.ts");
    const out = toToolExecutionResult({
      ok: true,
      source: "external_mcp",
      content: "Captured screen.",
      media: [{ kind: "image", mimeType: "image/png", data: PNG_1x1 }],
    });
    assert.equal(out.isError, false);
    assert.equal(out.content, "Captured screen.");
    assert.equal(out.media?.length, 1);
    assert.equal(out.media?.[0].data, PNG_1x1);
  });

  it("stringifies non-external results exactly as before", async () => {
    const { toToolExecutionResult } = await import("../src/lib/toolChat.ts");
    const out = toToolExecutionResult({ ok: true, status: 200, body: "hi" });
    assert.equal(out.isError, false);
    assert.equal(out.media, undefined);
    assert.equal(out.content, JSON.stringify({ ok: true, status: 200, body: "hi" }));
  });
});
