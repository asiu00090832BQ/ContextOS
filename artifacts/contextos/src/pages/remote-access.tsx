import { useState } from "react";
import { useRunCommand } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { Copy, Check, Radio, Terminal, KeyRound, Play } from "lucide-react";
import { toast } from "@/hooks/use-toast";

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative group">
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre">
        {code}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 flex items-center gap-1 rounded-md border bg-background/80 px-2 py-1 text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? (
          <Check className="w-3 h-3 text-green-500" />
        ) : (
          <Copy className="w-3 h-3" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function RemoteAccess() {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-app";
  const apiBase = `${origin}/api`;
  const mcpUrl = `${apiBase}/mcp`;
  const commandUrl = `${apiBase}/commands/run`;

  const runCommand = useRunCommand();
  const [goal, setGoal] = useState("");
  const [lastResult, setLastResult] = useState<string | null>(null);

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await runCommand.mutateAsync({ data: { goal: goal.trim() } });
      setLastResult(JSON.stringify(result, null, 2));
      toast({ title: "Command started", description: `Run ${result.runId}` });
      setGoal("");
    } catch (error: any) {
      toast({
        title: "Failed to start command",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const restExample = `curl -X POST ${commandUrl} \\
  -H "Authorization: Bearer ctxos_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"goal": "Summarize today's open intents"}'`;

  const mcpInitExample = `curl -X POST ${mcpUrl} \\
  -H "Authorization: Bearer ctxos_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`;

  const mcpCallExample = `curl -X POST ${mcpUrl} \\
  -H "Authorization: Bearer ctxos_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"run_command",
                 "arguments":{"goal":"Do the thing"}}}'`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono">Remote Access</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Let an AI on another computer drive this workspace — over a simple REST
          API or the built-in MCP server. Authenticate with an API key.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> 1. Get an API key
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          Every request authenticates with a Bearer token. Create one on the{" "}
          <Link href="/api-keys" className="text-primary hover:underline">
            API Keys
          </Link>{" "}
          page, then pass it as{" "}
          <code className="font-mono text-foreground">
            Authorization: Bearer ctxos_…
          </code>
          .
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" /> 2. REST API
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Endpoint</span>
            <code className="font-mono">{commandUrl}</code>
          </div>
          <p className="text-sm text-muted-foreground">
            One call creates an intent and starts a run. Returns{" "}
            <code className="font-mono text-foreground">
              {"{ intentId, runId, status }"}
            </code>
            .
          </p>
          <CodeBlock code={restExample} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary" /> 3. MCP Server
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">MCP endpoint</span>
            <code className="font-mono">{mcpUrl}</code>
          </div>
          <p className="text-sm text-muted-foreground">
            A stateless JSON-RPC 2.0 MCP server. Point any MCP-compatible client
            at it with your key. Supports{" "}
            <code className="font-mono text-foreground">initialize</code>,{" "}
            <code className="font-mono text-foreground">tools/list</code>, and{" "}
            <code className="font-mono text-foreground">tools/call</code> —
            including a{" "}
            <code className="font-mono text-foreground">register_mcp_server</code>{" "}
            tool that lets the AI connect and discover brand-new services on its
            own.
          </p>
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Initialize
            </span>
            <CodeBlock code={mcpInitExample} />
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Call a tool
            </span>
            <CodeBlock code={mcpCallExample} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Play className="h-4 w-4 text-primary" /> Try it now
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Send a command through the same REST endpoint, straight from here.
          </p>
          <form onSubmit={handleRun} className="flex gap-2">
            <input
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="flex-1 p-2 rounded-md border bg-background text-sm"
              placeholder="e.g. Summarize today's open intents"
            />
            <button
              disabled={runCommand.isPending}
              type="submit"
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
            >
              <Play className="w-4 h-4" />
              {runCommand.isPending ? "Running..." : "Run"}
            </button>
          </form>
          {lastResult && (
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs font-mono">
              {lastResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
