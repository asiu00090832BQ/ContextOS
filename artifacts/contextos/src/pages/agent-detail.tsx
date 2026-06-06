import { useState } from "react";
import { useRoute } from "wouter";
import {
  useGetAgent,
  getGetAgentQueryKey,
  useGetAgentMemories,
  getGetAgentMemoriesQueryKey,
  useListModelEndpoints,
  getListModelEndpointsQueryKey,
  useSetAgentModelPolicy,
} from "@workspace/api-client-react";
import type { WorkingMemory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Cpu,
  ServerCog,
  Shield,
  Settings2,
  Brain,
  Clock,
  RefreshCw,
} from "lucide-react";
import { Link } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function AgentDetail() {
  const [, params] = useRoute("/agents/:id");
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: agent, isLoading } = useGetAgent(id, {
    query: { enabled: !!id, queryKey: getGetAgentQueryKey(id) },
  });
  const { data: endpoints } = useListModelEndpoints({
    query: { queryKey: getListModelEndpointsQueryKey() },
  });
  const {
    data: memories,
    isLoading: memoriesLoading,
    isFetching: memoriesFetching,
    isError: memoriesError,
    refetch: refetchMemories,
  } = useGetAgentMemories(id, {
    query: { enabled: !!id, queryKey: getGetAgentMemoriesQueryKey(id) },
  });

  const setPolicyMutation = useSetAgentModelPolicy();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    primaryEndpointId: "",
    fallbackEndpointId: "",
    temperature: "0.7",
    maxTokens: "",
  });

  const endpointName = (endpointId?: string | null) =>
    endpoints?.find((e) => e.id === endpointId)?.name || endpointId || "None";

  const openDialog = () => {
    setForm({
      primaryEndpointId: agent?.modelPolicy?.primaryEndpointId || "",
      fallbackEndpointId: agent?.modelPolicy?.fallbackEndpointId || "",
      temperature: String((agent?.modelPolicy?.temperature ?? 70) / 100),
      maxTokens: agent?.modelPolicy?.maxTokens
        ? String(agent.modelPolicy.maxTokens)
        : "",
    });
    setIsOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setPolicyMutation.mutateAsync({
        id,
        data: {
          primaryEndpointId: form.primaryEndpointId || undefined,
          fallbackEndpointId: form.fallbackEndpointId || undefined,
          temperature: Math.round(parseFloat(form.temperature || "0") * 100),
          maxTokens: form.maxTokens.trim() ? Number(form.maxTokens) : undefined,
        },
      });
      toast({ title: "Model policy saved" });
      setIsOpen(false);
      queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(id) });
    } catch (error: any) {
      toast({
        title: "Failed to save model policy",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!agent)
    return (
      <div className="p-8 text-center text-muted-foreground">Agent not found.</div>
    );

  const hasEndpoints = (endpoints?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Cpu className="h-6 w-6 text-primary" /> {agent.name}
          </h1>
          <div className="text-sm text-muted-foreground mt-1">{agent.description}</div>
        </div>
        <div className={`px-3 py-1 rounded text-xs font-mono uppercase ${agent.isActive ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
          {agent.isActive ? 'Active' : 'Inactive'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><Shield className="w-5 h-5 text-muted-foreground"/> Identity & Role</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Role</div>
              <div className="text-sm font-mono bg-muted/30 p-2 rounded">{agent.role}</div>
            </div>
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase mb-1">System Prompt</div>
              <div className="text-sm bg-muted/30 p-3 rounded font-mono whitespace-pre-wrap text-muted-foreground h-48 overflow-y-auto">
                {agent.systemPrompt || 'No system prompt defined.'}
              </div>
            </div>
            <div>
               <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Context Policy</div>
               <div className="text-sm font-mono bg-muted/30 p-2 rounded uppercase">{agent.contextPolicy}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2"><ServerCog className="w-5 h-5 text-muted-foreground"/> Model Policy</CardTitle>
            <Dialog open={isOpen} onOpenChange={setIsOpen}>
              <DialogTrigger asChild>
                <button
                  onClick={openDialog}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  {agent.modelPolicy ? "Edit" : "Assign LLM"}
                </button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                  <DialogTitle>Model Policy</DialogTitle>
                </DialogHeader>
                {!hasEndpoints ? (
                  <div className="py-4 text-sm text-muted-foreground space-y-3">
                    <p>No model endpoints exist yet. Add an LLM first, then come back to assign it to this agent.</p>
                    <Link href="/model-endpoints">
                      <button className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
                        Go to Model Endpoints
                      </button>
                    </Link>
                  </div>
                ) : (
                  <form onSubmit={handleSave} className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Primary Endpoint</label>
                      <select
                        required
                        value={form.primaryEndpointId}
                        onChange={(e) => setForm({ ...form, primaryEndpointId: e.target.value })}
                        className="w-full p-2 rounded-md border bg-background"
                      >
                        <option value="" disabled>Select an endpoint…</option>
                        {endpoints?.map((ep) => (
                          <option key={ep.id} value={ep.id}>
                            {ep.name} ({ep.modelName})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Fallback Endpoint{" "}
                        <span className="text-muted-foreground font-normal">(optional)</span>
                      </label>
                      <select
                        value={form.fallbackEndpointId}
                        onChange={(e) => setForm({ ...form, fallbackEndpointId: e.target.value })}
                        className="w-full p-2 rounded-md border bg-background"
                      >
                        <option value="">None</option>
                        {endpoints
                          ?.filter((ep) => ep.id !== form.primaryEndpointId)
                          .map((ep) => (
                            <option key={ep.id} value={ep.id}>
                              {ep.name} ({ep.modelName})
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Temperature</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="2"
                          value={form.temperature}
                          onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                          className="w-full p-2 rounded-md border bg-background"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Max Tokens{" "}
                          <span className="text-muted-foreground font-normal">(opt.)</span>
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={form.maxTokens}
                          onChange={(e) => setForm({ ...form, maxTokens: e.target.value })}
                          className="w-full p-2 rounded-md border bg-background"
                          placeholder="default"
                        />
                      </div>
                    </div>
                    <button
                      disabled={setPolicyMutation.isPending}
                      type="submit"
                      className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
                    >
                      {setPolicyMutation.isPending ? "Saving..." : "Save Model Policy"}
                    </button>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent className="space-y-4">
            {agent.modelPolicy ? (
              <>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Primary Endpoint</span>
                  <span className="font-mono text-sm">{endpointName(agent.modelPolicy.primaryEndpointId)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Fallback Endpoint</span>
                  <span className="font-mono text-sm">{endpointName(agent.modelPolicy.fallbackEndpointId)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Temperature</span>
                  <span className="font-mono text-sm">{(agent.modelPolicy.temperature ?? 0) / 100}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Max Tokens</span>
                  <span className="font-mono text-sm">{agent.modelPolicy.maxTokens || 'Default'}</span>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground italic p-4 bg-muted/10 rounded">
                No model endpoint attached yet. Click "Assign LLM" to connect this agent to a model.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Brain className="w-5 h-5 text-muted-foreground" /> Memory
          </CardTitle>
          <button
            onClick={() => refetchMemories()}
            disabled={memoriesFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${memoriesFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2 text-xs font-mono">
            <span className="px-2 py-1 rounded bg-muted/40 text-muted-foreground uppercase">
              Context Policy: {memories?.contextPolicy ?? agent.contextPolicy}
            </span>
            <span className="px-2 py-1 rounded bg-muted/40 text-muted-foreground">
              Long-term: {memories?.longTerm.length ?? 0}
            </span>
            <span className="px-2 py-1 rounded bg-muted/40 text-muted-foreground">
              Short-term: {memories?.shortTerm.length ?? 0}
            </span>
          </div>

          {memoriesLoading ? (
            <Skeleton className="w-full h-32" />
          ) : memoriesError ? (
            <div className="text-sm text-destructive p-4 bg-destructive/10 rounded">
              Failed to load memories. Click Refresh to try again.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-mono uppercase text-muted-foreground">
                  <Brain className="w-4 h-4" /> Long-term
                  <span className="text-xs text-muted-foreground/60">(persists across runs)</span>
                </div>
                {memories && memories.longTerm.length > 0 ? (
                  memories.longTerm.map((m) => <MemoryItem key={m.id} memory={m} />)
                ) : (
                  <div className="text-sm text-muted-foreground italic p-4 bg-muted/10 rounded">
                    No long-term memories.
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-mono uppercase text-muted-foreground">
                  <Clock className="w-4 h-4" /> Short-term
                  <span className="text-xs text-muted-foreground/60">(run-scoped, pruned)</span>
                </div>
                {memories && memories.shortTerm.length > 0 ? (
                  memories.shortTerm.map((m) => <MemoryItem key={m.id} memory={m} showRun />)
                ) : (
                  <div className="text-sm text-muted-foreground italic p-4 bg-muted/10 rounded">
                    No short-term memories.
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MemoryItem({
  memory,
  showRun = false,
}: {
  memory: WorkingMemory;
  showRun?: boolean;
}) {
  return (
    <div className="rounded border border-border/50 bg-muted/20 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-mono uppercase">
          {memory.type}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono uppercase">
          {memory.sensitivity}
        </span>
        <span className="font-mono text-sm font-medium break-all">{memory.key}</span>
      </div>
      <div className="text-sm font-mono whitespace-pre-wrap break-words text-muted-foreground">
        {memory.value}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground/70">
        {memory.tags?.map((t) => (
          <span key={t} className="px-1.5 py-0.5 rounded bg-muted/50">
            #{t}
          </span>
        ))}
        {showRun && memory.runId && (
          <span className="px-1.5 py-0.5 rounded bg-muted/50">run: {memory.runId.slice(0, 8)}</span>
        )}
        <span className="ml-auto">{new Date(memory.createdAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
