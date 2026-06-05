import { useState } from "react";
import {
  useListAdapters,
  getListAdaptersQueryKey,
  useGetAdapter,
  getGetAdapterQueryKey,
  useCreateConstructedServer,
  useCreateAdapter,
  useImportOpenApi,
  useAddWebTool,
  useSetConstructedServerAuth,
  useDeleteCapability,
  useInvokeCapability,
  useDeleteAdapter,
  useRetestConstructedServer,
  useDiscoverAdapter,
  useTestAdapter,
} from "@workspace/api-client-react";
import type {
  Adapter,
  AdapterDetail,
  Capability,
  InvokeCapabilityResult,
  RetestServerResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import {
  Cable,
  Plus,
  Trash2,
  Globe,
  ShieldCheck,
  Play,
  FileJson,
  Bot,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Search,
  Activity,
  AlertTriangle,
  Info,
  Zap,
} from "lucide-react";

const botBadge = (
  <span className="flex items-center gap-1 text-xs font-medium bg-violet-500/15 text-violet-500 px-2 py-0.5 rounded shrink-0">
    <Bot className="w-3 h-3" /> Built by bot
  </span>
);

const inputClass = "w-full p-2 rounded-md border bg-background text-sm";
const labelClass = "text-sm font-medium";
const btnPrimary =
  "px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50";

interface ImportSmokeTest {
  ran?: boolean;
  reason?: string;
  tool?: string;
  ok?: boolean;
  status?: number | null;
  durationMs?: number;
  error?: string | null;
  hint?: string;
  ranAt?: string;
}

export function Servers() {
  const { data: adapters, isLoading } = useListAdapters({
    query: { queryKey: getListAdaptersQueryKey() },
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="w-full h-64" />;

  const servers = adapters ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Cable className="w-6 h-6 text-primary" /> MCP Servers
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Every MCP server your agents can use, with its tools nested
            underneath. Connect an existing MCP server, or build one from any web
            API.
          </p>
        </div>
        <AddServerDialog onCreated={(id) => setExpandedId(id)} />
      </div>

      {servers.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
          No MCP servers yet. Click <span className="font-medium">Add server</span>{" "}
          to connect or build one.
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((a) => (
            <ServerCard
              key={a.id}
              summary={a}
              expanded={expandedId === a.id}
              onToggle={() =>
                setExpandedId(expandedId === a.id ? null : a.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

type ServerSummary = Adapter;

function ServerCard({
  summary,
  expanded,
  onToggle,
}: {
  summary: ServerSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isBot = summary.createdVia === "agent";
  return (
    <Card className="overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left hover:bg-muted/30 transition-colors"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <ChevronRight
              className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <span className="font-medium truncate">{summary.name}</span>
            {isBot && botBadge}
          </div>
          <div className="flex items-center gap-2 text-xs shrink-0">
            <span className="hidden sm:inline bg-muted px-2 py-1 rounded font-mono">
              {summary.transport}
            </span>
            <span
              className={`px-2 py-1 rounded font-mono uppercase ${
                summary.status === "active"
                  ? "bg-green-500/20 text-green-500"
                  : "bg-muted"
              }`}
            >
              {summary.status}
            </span>
            <span className="bg-muted px-2 py-1 rounded font-mono">
              {summary.capabilityCount ?? 0} tools
            </span>
          </div>
        </CardHeader>
      </button>
      {expanded && (
        <CardContent className="border-t border-border/50 pt-4">
          <ServerPanel id={summary.id} onDeleted={onToggle} />
        </CardContent>
      )}
    </Card>
  );
}

function ServerPanel({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdapter(id, {
    query: { queryKey: getGetAdapterQueryKey(id) },
  });
  const deleteAdapterMutation = useDeleteAdapter();
  const retestMutation = useRetestConstructedServer();
  const discoverMutation = useDiscoverAdapter();
  const testMutation = useTestAdapter();
  const [retest, setRetest] = useState<RetestServerResult | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAdapterQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
  };

  const handleRetest = async () => {
    try {
      const res = await retestMutation.mutateAsync({ id });
      const summary = res as RetestServerResult;
      setRetest(summary);
      toast({
        title: `Re-test complete: ${summary.passed}/${summary.ran} passed`,
        description:
          summary.failed > 0
            ? `${summary.failed} tool${summary.failed === 1 ? "" : "s"} failed.`
            : summary.ran === 0
              ? "No safe read/list tools to dry-run."
              : "All safe tools responded correctly.",
        variant: summary.failed > 0 ? "destructive" : undefined,
      });
    } catch (error) {
      toast({
        title: "Re-test failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleDiscover = async () => {
    try {
      await discoverMutation.mutateAsync({ id });
      toast({
        title: "Discovery initiated",
        description: "Adapter capabilities are being updated.",
      });
      invalidate();
    } catch (error) {
      toast({
        title: "Discovery failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleTest = async () => {
    try {
      await testMutation.mutateAsync({ id });
      toast({
        title: "Health test initiated",
        description: "Testing adapter connectivity.",
      });
      invalidate();
    } catch (error) {
      toast({
        title: "Health test failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-48" />;
  if (!data) return null;
  const adapter = data as AdapterDetail;
  const isConstructed = adapter.transport === "constructed";
  const isBot = adapter.createdVia === "agent";

  const handleDeleteServer = async () => {
    if (
      !confirm(
        `Delete server "${adapter.name}" and all of its tools? This cannot be undone.`,
      )
    )
      return;
    try {
      await deleteAdapterMutation.mutateAsync({ id });
      toast({ title: "Server deleted" });
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
      onDeleted();
    } catch (error) {
      toast({
        title: "Failed to delete server",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-5">
      {isBot && (
        <p className="text-xs text-violet-500">
          This server was built by the assistant. Review its tools, test them,
          fix auth, or delete what you don't need.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground font-mono min-w-0">
          {adapter.endpointUrl && (
            <span className="truncate max-w-md">{adapter.endpointUrl}</span>
          )}
          {isConstructed && (
            <span className="bg-muted px-2 py-1 rounded">
              auth: {adapter.authType ?? "none"}
            </span>
          )}
          {!isConstructed && adapter.protocolVersion && (
            <span className="bg-muted px-2 py-1 rounded">
              v{adapter.protocolVersion}
            </span>
          )}
          {adapter.allowPrivateNetwork ? (
            <span className="text-amber-500">• private network allowed</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isConstructed ? (
            <button
              onClick={handleRetest}
              disabled={retestMutation.isPending}
              title="Dry-run every safe read/list tool to re-verify this server"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-primary hover:border-primary/50 disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  retestMutation.isPending ? "animate-spin" : ""
                }`}
              />
              {retestMutation.isPending ? "Re-testing..." : "Re-test"}
            </button>
          ) : (
            <>
              <button
                onClick={handleDiscover}
                disabled={discoverMutation.isPending}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-primary hover:border-primary/50 disabled:opacity-50"
              >
                <Search className="w-3.5 h-3.5" /> Discover
              </button>
              <button
                onClick={handleTest}
                disabled={testMutation.isPending}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-primary hover:border-primary/50 disabled:opacity-50"
              >
                <Activity className="w-3.5 h-3.5" /> Test Health
              </button>
            </>
          )}
          <button
            onClick={handleDeleteServer}
            disabled={deleteAdapterMutation.isPending}
            title="Delete server"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      <ImportHealth smoke={(adapter as { lastImportSmokeTest?: ImportSmokeTest | null }).lastImportSmokeTest} />

      {retest && <RetestResults summary={retest} />}

      {isConstructed && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ImportOpenApiCard id={id} onDone={invalidate} />
          <AddToolCard id={id} onDone={invalidate} />
          <AuthCard
            id={id}
            currentType={adapter.authType ?? "none"}
            onDone={invalidate}
          />
        </div>
      )}

      <ToolsList
        tools={adapter.capabilities ?? []}
        constructed={isConstructed}
        onDone={invalidate}
      />
    </div>
  );
}

function AddServerDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"build" | "connect">("build");

  const createConstructed = useCreateConstructedServer();
  const createAdapter = useCreateAdapter();

  const [build, setBuild] = useState({
    name: "",
    baseUrl: "",
    description: "",
    allowPrivateNetwork: false,
  });
  const [connect, setConnect] = useState({
    name: "",
    transport: "streamable_http",
    endpointUrl: "",
  });

  const reset = () => {
    setBuild({ name: "", baseUrl: "", description: "", allowPrivateNetwork: false });
    setConnect({ name: "", transport: "streamable_http", endpointUrl: "" });
  };

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await createConstructed.mutateAsync({
        data: {
          name: build.name,
          baseUrl: build.baseUrl,
          description: build.description || undefined,
          allowPrivateNetwork: build.allowPrivateNetwork,
        },
      });
      toast({ title: "Server created" });
      setOpen(false);
      reset();
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
      onCreated((res as AdapterDetail).id);
    } catch (error) {
      toast({
        title: "Failed to create server",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await createAdapter.mutateAsync({ data: connect });
      toast({ title: "Server connected" });
      setOpen(false);
      reset();
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
      const created = res as AdapterDetail;
      if (created?.id) onCreated(created.id);
    } catch (error) {
      toast({
        title: "Failed to connect server",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className={`flex items-center gap-2 ${btnPrimary}`}>
          <Plus className="w-4 h-4" /> Add server
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 p-1 bg-muted/40 rounded-lg mt-2">
          <button
            onClick={() => setMode("build")}
            className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              mode === "build"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Build from web API
          </button>
          <button
            onClick={() => setMode("connect")}
            className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              mode === "connect"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Connect existing server
          </button>
        </div>

        {mode === "build" ? (
          <form onSubmit={handleBuild} className="space-y-4 pt-4">
            <p className="text-xs text-muted-foreground">
              Wrap any REST/HTTP API as an MCP server. After creating it, import
              an OpenAPI spec or add individual endpoints as tools.
            </p>
            <div className="space-y-2">
              <label className={labelClass}>Name</label>
              <input
                required
                value={build.name}
                onChange={(e) => setBuild({ ...build, name: e.target.value })}
                className={inputClass}
                placeholder="e.g. Weather API"
              />
            </div>
            <div className="space-y-2">
              <label className={labelClass}>Base URL</label>
              <input
                required
                value={build.baseUrl}
                onChange={(e) => setBuild({ ...build, baseUrl: e.target.value })}
                className={inputClass}
                placeholder="https://api.example.com"
              />
            </div>
            <div className="space-y-2">
              <label className={labelClass}>Description</label>
              <input
                value={build.description}
                onChange={(e) =>
                  setBuild({ ...build, description: e.target.value })
                }
                className={inputClass}
                placeholder="Optional"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={build.allowPrivateNetwork}
                onChange={(e) =>
                  setBuild({ ...build, allowPrivateNetwork: e.target.checked })
                }
              />
              Allow private/LAN network access (disables SSRF protection)
            </label>
            <button
              disabled={createConstructed.isPending}
              type="submit"
              className={`w-full ${btnPrimary}`}
            >
              {createConstructed.isPending ? "Creating..." : "Create Server"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleConnect} className="space-y-4 pt-4">
            <p className="text-xs text-muted-foreground">
              Register an existing MCP server. After connecting, expand it and
              click <span className="font-medium">Discover</span> to import its
              tools.
            </p>
            <div className="space-y-2">
              <label className={labelClass}>Name</label>
              <input
                required
                value={connect.name}
                onChange={(e) =>
                  setConnect({ ...connect, name: e.target.value })
                }
                className={inputClass}
                placeholder="e.g. GitHub Tools"
              />
            </div>
            <div className="space-y-2">
              <label className={labelClass}>Transport</label>
              <select
                value={connect.transport}
                onChange={(e) =>
                  setConnect({ ...connect, transport: e.target.value })
                }
                className={inputClass}
              >
                <option value="streamable_http">
                  Streamable HTTP (MCP server)
                </option>
                <option value="websocket">WebSocket</option>
                <option value="stdio">Stdio (Local)</option>
                <option value="demo">Demo</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className={labelClass}>Endpoint URL</label>
              <input
                value={connect.endpointUrl}
                onChange={(e) =>
                  setConnect({ ...connect, endpointUrl: e.target.value })
                }
                className={inputClass}
                placeholder="https://example.com/mcp"
              />
            </div>
            <button
              disabled={createAdapter.isPending}
              type="submit"
              className={`w-full ${btnPrimary}`}
            >
              {createAdapter.isPending ? "Connecting..." : "Connect Server"}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportHealth({ smoke }: { smoke?: ImportSmokeTest | null }) {
  if (!smoke) return null;
  const failed = smoke.ran === true && smoke.ok === false;
  const passed = smoke.ran === true && smoke.ok === true;
  const tone = failed
    ? "border-destructive/50 bg-destructive/10"
    : passed
      ? "border-green-500/40 bg-green-500/10"
      : "border-border/50 bg-muted/20";
  return (
    <Card className={tone} data-testid="card-import-smoke-test">
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-sm">
            {failed ? (
              <AlertTriangle className="w-4 h-4 text-destructive" />
            ) : passed ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : (
              <Info className="w-4 h-4 text-muted-foreground" />
            )}
            Last import smoke test
          </div>
          <span
            className={`text-xs px-2 py-0.5 rounded font-mono uppercase ${
              failed
                ? "bg-destructive/20 text-destructive"
                : passed
                  ? "bg-green-500/20 text-green-500"
                  : "bg-muted text-muted-foreground"
            }`}
            data-testid="badge-import-smoke-status"
          >
            {failed ? "Failed" : passed ? "Passed" : "Skipped"}
          </span>
        </div>

        {smoke.ran ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">Tool</div>
              <div className="font-mono break-all">{smoke.tool ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">HTTP status</div>
              <div className="font-mono">{smoke.status ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Duration</div>
              <div className="font-mono">
                {typeof smoke.durationMs === "number"
                  ? `${smoke.durationMs}ms`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Ran at</div>
              <div className="font-mono">
                {smoke.ranAt ? new Date(smoke.ranAt).toLocaleString() : "—"}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {smoke.reason ?? "No tool was auto-tested for this import."}
          </div>
        )}

        {failed && smoke.error && (
          <div
            className="text-xs font-mono bg-destructive/15 text-destructive rounded p-2 break-all"
            data-testid="text-import-smoke-error"
          >
            {smoke.error}
          </div>
        )}

        {smoke.hint && (
          <div className="text-xs text-muted-foreground">{smoke.hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportOpenApiCard({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [specUrl, setSpecUrl] = useState("");
  const [specText, setSpecText] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const mutation = useImportOpenApi();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await mutation.mutateAsync({
        id,
        data: {
          specUrl: specUrl || undefined,
          specText: specText || undefined,
          replaceExisting,
        },
      });
      const count = (res as AdapterDetail).capabilities?.length ?? 0;
      toast({ title: `Imported ${count} tools` });
      setOpen(false);
      setSpecUrl("");
      setSpecText("");
      onDone();
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex flex-col items-center gap-2 p-4 rounded-lg border hover:border-primary/50 transition-colors text-center">
          <FileJson className="w-5 h-5 text-primary" />
          <span className="text-sm font-medium">Import OpenAPI</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Import OpenAPI / Swagger Spec</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <label className={labelClass}>Spec URL</label>
            <input
              value={specUrl}
              onChange={(e) => setSpecUrl(e.target.value)}
              className={inputClass}
              placeholder="https://api.example.com/openapi.json"
            />
          </div>
          <div className="text-center text-xs text-muted-foreground">or</div>
          <div className="space-y-2">
            <label className={labelClass}>Paste Spec (JSON or YAML)</label>
            <textarea
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              className={`${inputClass} font-mono h-32`}
              placeholder="openapi: 3.0.0 ..."
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={replaceExisting}
              onChange={(e) => setReplaceExisting(e.target.checked)}
            />
            Replace existing tools
          </label>
          <button
            disabled={mutation.isPending}
            type="submit"
            className={`w-full ${btnPrimary}`}
          >
            {mutation.isPending ? "Importing..." : "Import Tools"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddToolCard({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("GET");
  const [pathTemplate, setPathTemplate] = useState("");
  const [recipeText, setRecipeText] = useState("");
  const mutation = useAddWebTool();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let recipe: Record<string, unknown>;
    if (recipeText.trim()) {
      try {
        recipe = JSON.parse(recipeText);
      } catch {
        toast({ title: "Recipe is not valid JSON", variant: "destructive" });
        return;
      }
    } else {
      recipe = { kind: "http", method, pathTemplate };
    }
    try {
      await mutation.mutateAsync({
        id,
        data: {
          name,
          description: description || undefined,
          kind: "http",
          recipe,
        },
      });
      toast({ title: "Tool added" });
      setOpen(false);
      setName("");
      setDescription("");
      setPathTemplate("");
      setRecipeText("");
      onDone();
    } catch (error) {
      toast({
        title: "Failed to add tool",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex flex-col items-center gap-2 p-4 rounded-lg border hover:border-primary/50 transition-colors text-center">
          <Globe className="w-5 h-5 text-primary" />
          <span className="text-sm font-medium">Add HTTP Tool</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add HTTP Tool</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <label className={labelClass}>Tool Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="get_weather"
            />
          </div>
          <div className="space-y-2">
            <label className={labelClass}>Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
              placeholder="Optional"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-2">
              <label className={labelClass}>Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={inputClass}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2 col-span-2">
              <label className={labelClass}>Path Template</label>
              <input
                value={pathTemplate}
                onChange={(e) => setPathTemplate(e.target.value)}
                className={`${inputClass} font-mono`}
                placeholder="/weather?city={city}"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className={labelClass}>
              Advanced recipe JSON (optional, overrides above)
            </label>
            <textarea
              value={recipeText}
              onChange={(e) => setRecipeText(e.target.value)}
              className={`${inputClass} font-mono h-28`}
              placeholder='{"kind":"http","method":"GET","pathTemplate":"/x"}'
            />
          </div>
          <button
            disabled={mutation.isPending}
            type="submit"
            className={`w-full ${btnPrimary}`}
          >
            {mutation.isPending ? "Adding..." : "Add Tool"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthCard({
  id,
  currentType,
  onDone,
}: {
  id: string;
  currentType: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<
    "none" | "bearer" | "api_key_header" | "query"
  >((currentType as "none") || "none");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const mutation = useSetConstructedServerAuth();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await mutation.mutateAsync({
        id,
        data: {
          type,
          name: name || undefined,
          secret: secret || undefined,
        },
      });
      toast({ title: "Authentication updated" });
      setOpen(false);
      setSecret("");
      onDone();
    } catch (error) {
      toast({
        title: "Failed to update auth",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex flex-col items-center gap-2 p-4 rounded-lg border hover:border-primary/50 transition-colors text-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <span className="text-sm font-medium">Set Auth</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Configure Authentication</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <label className={labelClass}>Type</label>
            <select
              value={type}
              onChange={(e) =>
                setType(
                  e.target.value as
                    | "none"
                    | "bearer"
                    | "api_key_header"
                    | "query",
                )
              }
              className={inputClass}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api_key_header">API key (header)</option>
              <option value="query">API key (query param)</option>
            </select>
          </div>
          {(type === "api_key_header" || type === "query") && (
            <div className="space-y-2">
              <label className={labelClass}>
                {type === "query" ? "Query param name" : "Header name"}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                placeholder={type === "query" ? "api_key" : "X-API-Key"}
              />
            </div>
          )}
          {type !== "none" && (
            <div className="space-y-2">
              <label className={labelClass}>Secret value</label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                className={inputClass}
                placeholder="Stored securely; never returned"
              />
            </div>
          )}
          <button
            disabled={mutation.isPending}
            type="submit"
            className={`w-full ${btnPrimary}`}
          >
            {mutation.isPending ? "Saving..." : "Save Auth"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToolsList({
  tools,
  constructed,
  onDone,
}: {
  tools: Capability[];
  constructed: boolean;
  onDone: () => void;
}) {
  const deleteMutation = useDeleteCapability();

  const handleDelete = async (capId: string) => {
    if (!confirm("Delete this tool?")) return;
    try {
      await deleteMutation.mutateAsync({ id: capId });
      toast({ title: "Tool deleted" });
      onDone();
    } catch (error) {
      toast({
        title: "Failed to delete tool",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (tools.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
        {constructed
          ? "No tools yet. Import an OpenAPI spec or add an HTTP tool."
          : "No tools discovered yet. Click Discover to import them."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
        <Zap className="w-3.5 h-3.5" /> Tools ({tools.length})
      </h2>
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} onDelete={handleDelete} />
      ))}
    </div>
  );
}

function ToolRow({
  tool,
  onDelete,
}: {
  tool: Capability;
  onDelete: (id: string) => void;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<InvokeCapabilityResult | null>(null);
  const invokeMutation = useInvokeCapability();

  const runTest = async () => {
    let args: Record<string, unknown> = {};
    if (argsText.trim()) {
      try {
        args = JSON.parse(argsText);
      } catch {
        toast({ title: "Arguments are not valid JSON", variant: "destructive" });
        return;
      }
    }
    try {
      const res = await invokeMutation.mutateAsync({
        id: tool.id,
        data: { arguments: args },
      });
      setResult(res as InvokeCapabilityResult);
    } catch (error) {
      toast({
        title: "Invocation failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-medium truncate">{tool.name}</span>
              <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">
                {tool.riskTier}
              </span>
              {tool.executionKind && (
                <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded font-mono">
                  {tool.executionKind}
                </span>
              )}
            </div>
            {tool.description && (
              <p className="text-xs text-muted-foreground mt-1 truncate">
                {tool.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setTestOpen((v) => !v)}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border hover:border-primary/50"
            >
              <Play className="w-3 h-3" /> Test
            </button>
            <button
              onClick={() => onDelete(tool.id)}
              className="p-1.5 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {testOpen && (
          <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
            <label className={labelClass}>Arguments (JSON)</label>
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className={`${inputClass} font-mono h-20`}
            />
            <button
              onClick={runTest}
              disabled={invokeMutation.isPending}
              className={btnPrimary}
            >
              {invokeMutation.isPending ? "Running..." : "Invoke"}
            </button>
            {result && (
              <div className="mt-2">
                <div
                  className={`text-xs font-mono mb-1 ${
                    result.ok ? "text-green-500" : "text-destructive"
                  }`}
                >
                  {result.ok ? "OK" : "FAILED"}
                  {result.status != null ? ` • HTTP ${result.status}` : ""} •{" "}
                  {result.durationMs}ms
                </div>
                <pre className="text-xs bg-muted/40 p-3 rounded-md overflow-auto max-h-64 font-mono">
                  {JSON.stringify(
                    result.error ?? result.extracted ?? result.body,
                    null,
                    2,
                  )}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RetestResults({ summary }: { summary: RetestServerResult }) {
  const allOk = summary.failed === 0;
  return (
    <Card
      className={
        summary.ran === 0
          ? ""
          : allOk
            ? "border-green-500/40"
            : "border-destructive/40"
      }
    >
      <CardHeader className="pb-2 border-b border-border/50">
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="w-4 h-4 text-primary" /> Re-test results
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <span className="text-green-500">{summary.passed} passed</span>
          <span className="text-muted-foreground">•</span>
          <span
            className={
              summary.failed > 0 ? "text-destructive" : "text-muted-foreground"
            }
          >
            {summary.failed} failed
          </span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">
            {summary.skipped} skipped (mutating / unsafe)
          </span>
          <span className="text-muted-foreground">of {summary.total} total</span>
        </div>
        {summary.ran === 0 ? (
          <p className="text-sm text-muted-foreground">
            No safe read/list tools were available to dry-run. Mutating
            (create/update/destructive) tools are never auto-invoked.
          </p>
        ) : (
          <div className="space-y-1.5">
            {summary.results.map((r) => (
              <div
                key={r.name}
                className="flex items-start gap-2 text-xs border-b border-border/30 pb-1.5 last:border-0"
              >
                {r.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-medium">{r.name}</span>
                    <span className="text-muted-foreground font-mono">
                      {r.status != null ? `HTTP ${r.status}` : "no response"} •{" "}
                      {r.durationMs}ms
                    </span>
                  </div>
                  {!r.ok && r.error && (
                    <p className="text-destructive font-mono mt-0.5 break-words">
                      {r.error}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
