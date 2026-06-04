import { useState } from "react";
import {
  useListAdapters,
  getListAdaptersQueryKey,
  useGetAdapter,
  getGetAdapterQueryKey,
  useCreateConstructedServer,
  useImportOpenApi,
  useAddWebTool,
  useSetConstructedServerAuth,
  useDeleteCapability,
  useInvokeCapability,
  useDeleteAdapter,
  useRetestConstructedServer,
} from "@workspace/api-client-react";
import type {
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
  Wrench,
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
} from "lucide-react";

const botBadge = (
  <span className="flex items-center gap-1 text-xs font-medium bg-violet-500/15 text-violet-500 px-2 py-0.5 rounded">
    <Bot className="w-3 h-3" /> Built by bot
  </span>
);

const inputClass = "w-full p-2 rounded-md border bg-background text-sm";
const labelClass = "text-sm font-medium";
const btnPrimary =
  "px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50";

export function BuildMcp() {
  const queryClient = useQueryClient();
  const { data: adapters, isLoading } = useListAdapters({
    query: { queryKey: getListAdaptersQueryKey() },
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    description: "",
    allowPrivateNetwork: false,
  });

  const createMutation = useCreateConstructedServer();

  const constructed = (adapters ?? []).filter(
    (a) => a.transport === "constructed",
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await createMutation.mutateAsync({
        data: {
          name: form.name,
          baseUrl: form.baseUrl,
          description: form.description || undefined,
          allowPrivateNetwork: form.allowPrivateNetwork,
        },
      });
      toast({ title: "Constructed server created" });
      setIsCreateOpen(false);
      setForm({
        name: "",
        baseUrl: "",
        description: "",
        allowPrivateNetwork: false,
      });
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
      setSelectedId((res as AdapterDetail).id);
    } catch (error) {
      toast({
        title: "Failed to create server",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-64" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Wrench className="w-6 h-6 text-primary" /> Build MCP
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Construct executable tools that wrap real web APIs. Constructed
            tools are callable by internal agents and external AIs via{" "}
            <code className="font-mono">/mcp</code>.
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className={`flex items-center gap-2 ${btnPrimary}`}>
              <Plus className="w-4 h-4" /> New Server
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Create Constructed MCP Server</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className={labelClass}>Name</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputClass}
                  placeholder="e.g. Weather API"
                />
              </div>
              <div className="space-y-2">
                <label className={labelClass}>Base URL</label>
                <input
                  required
                  value={form.baseUrl}
                  onChange={(e) =>
                    setForm({ ...form, baseUrl: e.target.value })
                  }
                  className={inputClass}
                  placeholder="https://api.example.com"
                />
              </div>
              <div className="space-y-2">
                <label className={labelClass}>Description</label>
                <input
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  className={inputClass}
                  placeholder="Optional"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.allowPrivateNetwork}
                  onChange={(e) =>
                    setForm({ ...form, allowPrivateNetwork: e.target.checked })
                  }
                />
                Allow private/LAN network access (disables SSRF protection)
              </label>
              <button
                disabled={createMutation.isPending}
                type="submit"
                className={`w-full ${btnPrimary}`}
              >
                {createMutation.isPending ? "Creating..." : "Create Server"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Constructed Servers
          </h2>
          {constructed.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
              No constructed servers yet.
            </div>
          )}
          {constructed.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                selectedId === a.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{a.name}</span>
                <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded shrink-0">
                  {a.capabilityCount ?? 0} tools
                </span>
              </div>
              {a.createdVia === "agent" && (
                <div className="mt-1.5">{botBadge}</div>
              )}
              <div className="text-xs text-muted-foreground font-mono truncate mt-1">
                {a.endpointUrl}
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-2">
          {selectedId ? (
            <ServerPanel id={selectedId} onDeleted={() => setSelectedId(null)} />
          ) : (
            <div className="p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
              Select or create a server to manage its tools.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ServerPanel({
  id,
  onDeleted,
}: {
  id: string;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdapter(id, {
    query: { queryKey: getGetAdapterQueryKey(id) },
  });
  const deleteAdapterMutation = useDeleteAdapter();
  const retestMutation = useRetestConstructedServer();
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

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!data) return null;
  const adapter = data as AdapterDetail;
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
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <span className="truncate">{adapter.name}</span>
              {isBot && botBadge}
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-mono font-normal bg-muted px-2 py-1 rounded">
                auth: {adapter.authType ?? "none"}
              </span>
              <button
                onClick={handleRetest}
                disabled={retestMutation.isPending}
                title="Dry-run every safe read/list tool to re-verify this server"
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-primary hover:border-primary/50 disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${retestMutation.isPending ? "animate-spin" : ""}`}
                />
                {retestMutation.isPending ? "Re-testing..." : "Re-test"}
              </button>
              <button
                onClick={handleDeleteServer}
                disabled={deleteAdapterMutation.isPending}
                title="Delete server"
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 text-sm text-muted-foreground font-mono">
          {isBot && (
            <p className="font-sans text-xs text-violet-500 mb-2">
              This server was built by the assistant. Review its tools, test
              them, fix auth, or delete what you don't need.
            </p>
          )}
          {adapter.endpointUrl}
          {adapter.allowPrivateNetwork ? (
            <span className="ml-2 text-amber-500">• private network allowed</span>
          ) : null}
        </CardContent>
      </Card>

      {retest && <RetestResults summary={retest} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ImportOpenApiCard id={id} onDone={invalidate} />
        <AddToolCard id={id} onDone={invalidate} />
        <AuthCard
          id={id}
          currentType={adapter.authType ?? "none"}
          onDone={invalidate}
        />
      </div>

      <ToolsList
        tools={adapter.capabilities ?? []}
        onDone={invalidate}
      />
    </div>
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
        data: { name, description: description || undefined, kind: "http", recipe },
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
  onDone,
}: {
  tools: Capability[];
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
        No tools yet. Import an OpenAPI spec or add an HTTP tool.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Tools ({tools.length})
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
            <div className="flex items-center gap-2">
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
                  {JSON.stringify(result.error ?? result.extracted ?? result.body, null, 2)}
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
          <span className={summary.failed > 0 ? "text-destructive" : "text-muted-foreground"}>
            {summary.failed} failed
          </span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">
            {summary.skipped} skipped (mutating / unsafe)
          </span>
          <span className="text-muted-foreground">
            of {summary.total} total
          </span>
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
