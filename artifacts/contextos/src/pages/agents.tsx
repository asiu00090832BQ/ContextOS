import { useState } from "react";
import {
  useListAgents,
  getListAgentsQueryKey,
  useCreateAgent,
  useDeleteAgent,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu, Settings2, Plus, Trash2 } from "lucide-react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

const ROLES = [
  { value: "lead", label: "Lead — plans and delegates" },
  { value: "specialist", label: "Specialist — does focused work" },
  { value: "verifier", label: "Verifier — checks outputs" },
  { value: "executor", label: "Executor — runs actions" },
  { value: "summarizer", label: "Summarizer — condenses results" },
  { value: "router", label: "Router — directs to other agents" },
  { value: "memory_manager", label: "Memory Manager — curates memory" },
] as const;

const CONTEXT_POLICIES = [
  { value: "isolated", label: "Isolated — sees nothing from other agents" },
  { value: "shared_summary", label: "Shared summary — sees summaries only" },
  { value: "shared_readonly", label: "Shared read-only — can read others" },
  { value: "shared_full", label: "Shared full — full access" },
  { value: "brokered", label: "Brokered — only what is explicitly granted" },
] as const;

const EMPTY_FORM = {
  name: "",
  role: "specialist",
  description: "",
  systemPrompt: "",
  contextPolicy: "isolated",
  capabilityScope: "",
  exposeAsCapabilityProvider: false,
};

export function Agents() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListAgents({ query: { queryKey: getListAgentsQueryKey() } });

  const createMutation = useCreateAgent();
  const deleteMutation = useDeleteAgent();

  const [, navigate] = useLocation();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(EMPTY_FORM);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const scope = formData.capabilityScope
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await createMutation.mutateAsync({
        data: {
          name: formData.name,
          role: formData.role,
          description: formData.description.trim() || undefined,
          systemPrompt: formData.systemPrompt.trim() || undefined,
          contextPolicy: formData.contextPolicy,
          capabilityScope: scope.length > 0 ? scope : undefined,
          exposeAsCapabilityProvider: formData.exposeAsCapabilityProvider,
        },
      });
      toast({ title: "Agent created" });
      setIsCreateOpen(false);
      setFormData(EMPTY_FORM);
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to create agent",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (deletingId) return;
    if (!confirm("Delete this agent?")) return;
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: "Agent deleted" });
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to delete agent",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Agent Roster</h1>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Add Agent
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Agent</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <input
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="e.g. Research Assistant"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full p-2 rounded-md border bg-background"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Description{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <input
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="What this agent is responsible for"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  System Prompt{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  value={formData.systemPrompt}
                  onChange={(e) =>
                    setFormData({ ...formData, systemPrompt: e.target.value })
                  }
                  className="w-full p-2 rounded-md border bg-background min-h-[80px]"
                  placeholder="Instructions that define how this agent behaves"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Context Policy</label>
                <select
                  value={formData.contextPolicy}
                  onChange={(e) =>
                    setFormData({ ...formData, contextPolicy: e.target.value })
                  }
                  className="w-full p-2 rounded-md border bg-background"
                >
                  {CONTEXT_POLICIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Controls how much of other agents' context this agent can see.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Capability Scope{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional, comma-separated)
                  </span>
                </label>
                <input
                  value={formData.capabilityScope}
                  onChange={(e) =>
                    setFormData({ ...formData, capabilityScope: e.target.value })
                  }
                  className="w-full p-2 rounded-md border bg-background"
                  placeholder="e.g. search.query, docs.read  (or * for all)"
                />
              </div>
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.exposeAsCapabilityProvider}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      exposeAsCapabilityProvider: e.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border"
                />
                Expose this agent as a capability other agents can call
              </label>
              <button
                disabled={createMutation.isPending}
                type="submit"
                className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
              >
                {createMutation.isPending ? "Creating..." : "Create Agent"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((agent) => (
          <Card
            key={agent.id}
            role="link"
            tabIndex={0}
            onClick={() => navigate(`/agents/${agent.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(`/agents/${agent.id}`);
            }}
            className="bg-card hover:border-primary/50 transition-colors cursor-pointer h-full focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-lg font-medium">{agent.name}</CardTitle>
              <Cpu className={`h-4 w-4 ${agent.isActive ? 'text-primary' : 'text-muted-foreground'}`} />
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-primary/10 text-primary px-2 py-1 rounded font-mono">{agent.role}</span>
                <span className={`px-2 py-1 rounded font-mono uppercase ${agent.isActive ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
                  {agent.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="text-sm text-muted-foreground line-clamp-2">
                {agent.description || 'No description.'}
              </div>

              <div className="mt-auto pt-3 border-t border-border/50 flex justify-between items-center text-xs text-muted-foreground">
                 <div className="flex items-center gap-1 font-mono uppercase">
                   <Settings2 className="w-3 h-3" /> {agent.contextPolicy}
                 </div>
                 <button
                   onClick={(e) => handleDelete(e, agent.id)}
                   disabled={deletingId === agent.id}
                   className="flex items-center gap-1 hover:text-destructive transition-colors disabled:opacity-50"
                 >
                   <Trash2 className="w-3 h-3" /> {deletingId === agent.id ? "Deleting..." : "Delete"}
                 </button>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No agents yet. Click "Add Agent" to create your first one.
          </div>
        )}
      </div>
    </div>
  );
}
