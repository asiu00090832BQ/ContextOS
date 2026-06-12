import { useState } from "react";
import {
  useListModelEndpoints,
  getListModelEndpointsQueryKey,
  useCreateModelEndpoint,
  useUpdateModelEndpoint,
  useDeleteModelEndpoint,
  useTestModelEndpoint,
  useListProviderModels,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerCog, Plus, Trash2, Activity, RefreshCw, Globe, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "openai_compatible", label: "OpenAI-compatible (local / self-hosted)" },
] as const;

const EMPTY_FORM = {
  name: "",
  providerType: "openai",
  modelName: "",
  baseUrl: "",
  host: "",
  port: "",
  apiKey: "",
  isDefault: false,
};

export function ModelEndpoints() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListModelEndpoints({
    query: { queryKey: getListModelEndpointsQueryKey() },
  });

  const createMutation = useCreateModelEndpoint();
  const updateMutation = useUpdateModelEndpoint();
  const deleteMutation = useDeleteModelEndpoint();
  const testMutation = useTestModelEndpoint();
  const listModelsMutation = useListProviderModels();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [browserCheckingId, setBrowserCheckingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [editForm, setEditForm] = useState({
    id: "",
    name: "",
    providerType: "openai",
    modelName: "",
    baseUrl: "",
    host: "",
    port: "",
    apiKey: "",
    requestTimeoutMs: "",
    isDefault: false,
    hasKey: false,
  });
  const [models, setModels] = useState<string[]>([]);
  const [editModels, setEditModels] = useState<string[]>([]);

  const runFetchModels = async (
    src: {
      providerType: string;
      baseUrl: string;
      host: string;
      port: string;
      apiKey: string;
      endpointId?: string;
    },
    setResult: (models: string[]) => void,
  ) => {
    try {
      const result = await listModelsMutation.mutateAsync({
        data: {
          providerType: src.providerType,
          baseUrl: src.baseUrl.trim() || undefined,
          host: src.host.trim() || undefined,
          port: src.port.trim() ? Number(src.port) : undefined,
          apiKey: src.apiKey.trim() || undefined,
          ...(src.endpointId ? { endpointId: src.endpointId } : {}),
        },
      });
      setResult(result.models);
      toast({
        title: result.models.length
          ? `Found ${result.models.length} models`
          : "No models returned",
      });
    } catch (error: any) {
      toast({
        title: "Couldn't fetch models",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleFetchModels = () => runFetchModels(formData, setModels);
  const handleFetchEditModels = () =>
    runFetchModels(
      { ...editForm, endpointId: editForm.id },
      setEditModels,
    );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListModelEndpointsQueryKey() });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.providerType === "openai_compatible" && !formData.baseUrl.trim()) {
      toast({
        title: "Base URL required",
        description:
          "OpenAI-compatible (local / self-hosted) endpoints need a Base URL.",
        variant: "destructive",
      });
      return;
    }
    try {
      await createMutation.mutateAsync({
        data: {
          name: formData.name,
          providerType: formData.providerType,
          modelName: formData.modelName,
          baseUrl: formData.baseUrl.trim() || undefined,
          host: formData.host.trim() || undefined,
          port: formData.port.trim() ? Number(formData.port) : undefined,
          apiKey: formData.apiKey.trim() || undefined,
          isDefault: formData.isDefault,
        },
      });
      toast({ title: "Model endpoint added" });
      setIsCreateOpen(false);
      setFormData(EMPTY_FORM);
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to add endpoint",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result: any = await testMutation.mutateAsync({ id });
      const ok = result?.ok ?? result?.status === "active";
      toast({
        title: ok
          ? "Endpoint is live"
          : "Not reachable — runs will use the simulated stub",
        description:
          result?.message ??
          result?.detail ??
          (ok
            ? undefined
            : "No live model was reached, so replies fall back to the deterministic simulated stub."),
        variant: ok ? undefined : "destructive",
      });
      invalidate();
    } catch (error: any) {
      toast({
        title: "Test failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setTestingId(null);
    }
  };

  // Test reachability directly from the user's browser. This is the only way to
  // reach a model on the user's own machine/LAN (localhost, 192.168.x.x, etc.),
  // which the cloud-hosted API server can never reach. It confirms the model is
  // alive locally — NOT that ContextOS runs can use it (runs call from the cloud
  // and still need a public/tunnel URL).
  const handleBrowserCheck = async (endpoint: {
    id: string;
    baseUrl?: string | null;
  }) => {
    const raw = endpoint.baseUrl?.trim();
    if (!raw) {
      toast({
        title: "No Base URL",
        description: "Add a Base URL to this endpoint first.",
        variant: "destructive",
      });
      return;
    }
    // Normalise: drop any query/hash, strip trailing slash, then build the
    // /models probe URL — reusing an existing /models or /vN segment if present
    // so atypical pastes don't produce a malformed URL.
    let base = raw.split(/[?#]/)[0].replace(/\/+$/, "");
    let url: string;
    if (/\/models$/.test(base)) {
      url = base;
    } else {
      if (!/\/v\d+$/.test(base)) base = `${base}/v1`;
      url = `${base}/models`;
    }
    const pageIsHttps = window.location.protocol === "https:";
    const targetIsHttp = /^http:\/\//i.test(url);
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    // URL.hostname returns "::1" for IPv6 loopback (no brackets).
    const isLocalhost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]";

    setBrowserCheckingId(endpoint.id);
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const ms = Math.round(performance.now() - start);
      if (!res.ok) {
        toast({
          title: "Reachable, but errored",
          description: `Your model server answered with HTTP ${res.status} at ${url}.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: `Alive — responded in ${ms}ms`,
          description: `Your browser reached ${url}. Note: for ContextOS runs to use it, the cloud server must reach it too (use a public tunnel URL).`,
        });
      }
    } catch (err: any) {
      clearTimeout(timer);
      let description: string;
      if (err?.name === "AbortError") {
        description =
          "Timed out from your browser. Make sure LM Studio's server is running and listening on this address/port.";
      } else if (pageIsHttps && targetIsHttp && !isLocalhost) {
        description =
          "Your browser blocked this as 'mixed content': ContextOS is on HTTPS but this URL is plain HTTP on a non-localhost address. Either open LM Studio on the SAME machine and use http://localhost:<port>/v1, or expose it through an HTTPS tunnel (ngrok / Cloudflare Tunnel) and use that URL.";
      } else if (/^https:\/\//i.test(url)) {
        description =
          "Couldn't connect. If LM Studio is serving plain HTTP, change the Base URL to start with http:// instead of https://. Otherwise it may be a TLS or CORS issue — enable CORS in LM Studio's server settings.";
      } else {
        description =
          "Couldn't connect. Check that LM Studio is running, the host/port are correct, and CORS is enabled in its server settings.";
      }
      toast({ title: "Not reachable from your browser", description, variant: "destructive" });
    } finally {
      setBrowserCheckingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this model endpoint?")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: "Model endpoint deleted" });
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to delete endpoint",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleEditOpen = (endpoint: {
    id: string;
    name: string;
    providerType: string;
    modelName: string;
    baseUrl?: string | null;
    host?: string | null;
    port?: number | null;
    requestTimeoutMs?: number | null;
    isDefault?: boolean;
    apiKeyMasked?: string | null;
  }) => {
    setEditForm({
      id: endpoint.id,
      name: endpoint.name,
      providerType: endpoint.providerType,
      modelName: endpoint.modelName,
      baseUrl: endpoint.baseUrl ?? "",
      host: endpoint.host ?? "",
      port: endpoint.port != null ? String(endpoint.port) : "",
      apiKey: "",
      requestTimeoutMs:
        endpoint.requestTimeoutMs != null ? String(endpoint.requestTimeoutMs) : "",
      isDefault: Boolean(endpoint.isDefault),
      hasKey: Boolean(endpoint.apiKeyMasked),
    });
    setEditModels([]);
    setIsEditOpen(true);
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editForm.providerType === "openai_compatible" && !editForm.baseUrl.trim()) {
      toast({
        title: "Base URL required",
        description:
          "OpenAI-compatible (local / self-hosted) endpoints need a Base URL.",
        variant: "destructive",
      });
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: editForm.id,
        data: {
          name: editForm.name,
          modelName: editForm.modelName,
          isDefault: editForm.isDefault,
          // Only send connection fields when present so untouched/empty inputs
          // don't overwrite a stored baseUrl/host (e.g. host/port-backed rows).
          ...(editForm.baseUrl.trim() ? { baseUrl: editForm.baseUrl.trim() } : {}),
          ...(editForm.host.trim() ? { host: editForm.host.trim() } : {}),
          ...(editForm.port.trim() ? { port: Number(editForm.port) } : {}),
          ...(editForm.requestTimeoutMs.trim()
            ? { requestTimeoutMs: Number(editForm.requestTimeoutMs) }
            : {}),
          ...(editForm.apiKey.trim() ? { apiKey: editForm.apiKey.trim() } : {}),
        },
      });
      toast({ title: "Model endpoint updated" });
      setIsEditOpen(false);
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to update endpoint",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const isOpenAiCompatible = formData.providerType === "openai_compatible";

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Model Endpoints</h1>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Add LLM
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Add Model Endpoint</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <input
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="e.g. My GPT-4o"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider</label>
                <select
                  value={formData.providerType}
                  onChange={(e) => {
                    setFormData({ ...formData, providerType: e.target.value });
                    setModels([]);
                  }}
                  className="w-full p-2 rounded-md border bg-background"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Model Name</label>
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={listModelsMutation.isPending}
                    className="flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-60"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${
                        listModelsMutation.isPending ? "animate-spin" : ""
                      }`}
                    />
                    {listModelsMutation.isPending
                      ? "Fetching..."
                      : "Fetch models"}
                  </button>
                </div>
                {models.length > 0 ? (
                  <>
                    <select
                      required
                      value={formData.modelName}
                      onChange={(e) =>
                        setFormData({ ...formData, modelName: e.target.value })
                      }
                      className="w-full p-2 rounded-md border bg-background"
                    >
                      <option value="" disabled>
                        Select a model…
                      </option>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setModels([])}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      Enter manually instead
                    </button>
                  </>
                ) : (
                  <input
                    required
                    value={formData.modelName}
                    onChange={(e) =>
                      setFormData({ ...formData, modelName: e.target.value })
                    }
                    className="w-full p-2 rounded-md border bg-background"
                    placeholder="e.g. gpt-4o, claude-3-5-sonnet, llama3.1"
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  Enter the provider details and key, then "Fetch models" to load
                  the live list.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Base URL{" "}
                  <span className="text-muted-foreground font-normal">
                    {isOpenAiCompatible ? "(required for local / self-hosted)" : "(optional)"}
                  </span>
                </label>
                <input
                  required={isOpenAiCompatible}
                  value={formData.baseUrl}
                  onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="e.g. http://localhost:1234/v1"
                />
                {isOpenAiCompatible && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    LM Studio / Ollama serve plain <code>http://</code> (not https)
                    and live at <code>…/v1</code>. A private address like{" "}
                    <code>localhost</code> or <code>192.168.x.x</code> only works for
                    runs if ContextOS's cloud server can reach it — for that, expose
                    it with a public tunnel (ngrok / Cloudflare Tunnel) and paste the
                    tunnel's HTTPS URL here. Use "Check from browser" to confirm it's
                    alive on your machine.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  API Key{" "}
                  <span className="text-muted-foreground font-normal">
                    (stored securely, never shown again)
                  </span>
                </label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="sk-..."
                />
              </div>
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isDefault}
                  onChange={(e) =>
                    setFormData({ ...formData, isDefault: e.target.checked })
                  }
                  className="h-4 w-4 rounded border"
                />
                Set as default endpoint
              </label>
              <button
                disabled={createMutation.isPending}
                type="submit"
                className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
              >
                {createMutation.isPending ? "Adding..." : "Add Endpoint"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((endpoint) => (
          <Card key={endpoint.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-lg font-medium flex items-center gap-2">
                <ServerCog className="h-4 w-4 text-primary" />
                {endpoint.name}
              </CardTitle>
              {endpoint.isDefault && (
                <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded font-mono uppercase">
                  Default
                </span>
              )}
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <div className="text-muted-foreground">Provider</div>
                <div className="font-mono uppercase">{endpoint.providerType}</div>

                <div className="text-muted-foreground">Model</div>
                <div className="font-mono">{endpoint.modelName}</div>

                <div className="text-muted-foreground">Status</div>
                <div className="font-mono uppercase flex items-center gap-1">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      endpoint.status === "active" ? "bg-green-500" : "bg-red-500"
                    }`}
                  ></div>
                  {endpoint.status}
                </div>
              </div>

              {endpoint.apiKeyMasked && (
                <div className="mt-2 text-xs font-mono bg-muted/30 p-2 rounded border border-border/50 text-muted-foreground flex justify-between items-center">
                  <span>API Key: {endpoint.apiKeyMasked}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => handleTest(endpoint.id)}
                  disabled={testingId === endpoint.id}
                  title="Test from the cloud server — this is what ContextOS runs actually use."
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-60"
                >
                  <Activity className="w-3.5 h-3.5" />
                  {testingId === endpoint.id ? "Testing..." : "Test (server)"}
                </button>
                {endpoint.providerType === "openai_compatible" && (
                  <button
                    onClick={() => handleBrowserCheck(endpoint)}
                    disabled={browserCheckingId === endpoint.id}
                    title="Check reachability from your browser — works for a model on your own machine/LAN."
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-60"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    {browserCheckingId === endpoint.id ? "Checking..." : "Check from browser"}
                  </button>
                )}
                <button
                  onClick={() => handleEditOpen(endpoint)}
                  title="Edit this endpoint's model, Base URL, key, timeout, or default."
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(endpoint.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No model endpoints defined. Click "Add LLM" to connect your own model.
          </div>
        )}
      </div>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Edit Model Endpoint</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <input
                required
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full p-2 rounded-md border bg-background"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Provider</label>
              <input
                disabled
                value={
                  PROVIDERS.find((p) => p.value === editForm.providerType)?.label ??
                  editForm.providerType
                }
                className="w-full p-2 rounded-md border bg-muted text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Provider type can't be changed. Delete and re-add to switch providers.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Model Name</label>
                <button
                  type="button"
                  onClick={handleFetchEditModels}
                  disabled={listModelsMutation.isPending}
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-60"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${listModelsMutation.isPending ? "animate-spin" : ""}`}
                  />
                  {listModelsMutation.isPending ? "Fetching..." : "Fetch models"}
                </button>
              </div>
              {editModels.length > 0 ? (
                <>
                  <select
                    required
                    value={editForm.modelName}
                    onChange={(e) =>
                      setEditForm({ ...editForm, modelName: e.target.value })
                    }
                    className="w-full p-2 rounded-md border bg-background"
                  >
                    <option value="" disabled>
                      Select a model…
                    </option>
                    {editModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setEditModels([])}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Enter manually instead
                  </button>
                </>
              ) : (
                <input
                  required
                  value={editForm.modelName}
                  onChange={(e) =>
                    setEditForm({ ...editForm, modelName: e.target.value })
                  }
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet"
                />
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Base URL{" "}
                <span className="text-muted-foreground font-normal">
                  {editForm.providerType === "openai_compatible"
                    ? "(required for local / self-hosted)"
                    : "(optional)"}
                </span>
              </label>
              <input
                required={editForm.providerType === "openai_compatible"}
                value={editForm.baseUrl}
                onChange={(e) =>
                  setEditForm({ ...editForm, baseUrl: e.target.value })
                }
                className="w-full p-2 rounded-md border bg-background"
                placeholder="e.g. http://localhost:1234/v1"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                API Key{" "}
                <span className="text-muted-foreground font-normal">
                  {editForm.hasKey ? "(leave blank to keep current)" : "(optional)"}
                </span>
              </label>
              <input
                type="password"
                value={editForm.apiKey}
                onChange={(e) =>
                  setEditForm({ ...editForm, apiKey: e.target.value })
                }
                className="w-full p-2 rounded-md border bg-background"
                placeholder={editForm.hasKey ? "•••• keep current key" : "sk-..."}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Request timeout (ms){" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                type="number"
                min={1000}
                value={editForm.requestTimeoutMs}
                onChange={(e) =>
                  setEditForm({ ...editForm, requestTimeoutMs: e.target.value })
                }
                className="w-full p-2 rounded-md border bg-background"
                placeholder="e.g. 60000 for slow / reasoning models"
              />
            </div>

            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={editForm.isDefault}
                onChange={(e) =>
                  setEditForm({ ...editForm, isDefault: e.target.checked })
                }
                className="h-4 w-4 rounded border"
              />
              Set as default endpoint
            </label>

            <button
              disabled={updateMutation.isPending}
              type="submit"
              className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
            >
              {updateMutation.isPending ? "Saving..." : "Save changes"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
