import { useState, useEffect } from "react";
import {
  useGetBot,
  getGetBotQueryKey,
  useUpdateBotPolicy,
  useListBotMemories,
  getListBotMemoriesQueryKey,
  useCreateBotMemory,
  useUpdateBotMemory,
  useDeleteBotMemory,
  useListBotShortTerm,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot as BotIcon, BrainCircuit, Plus, Trash2, Pencil, ShieldOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

const CONTEXT_POLICIES = [
  { value: "isolated", label: "Isolated — only the bot's own memory" },
  { value: "shared_summary", label: "Shared summary — also tenant summaries" },
  { value: "shared_readonly", label: "Shared read-only — also tenant memory" },
  { value: "shared_full", label: "Shared full — full tenant memory" },
  { value: "brokered", label: "Brokered — only explicitly granted" },
] as const;

const MEMORY_TYPES = [
  { value: "semantic", label: "Semantic — facts & knowledge" },
  { value: "procedural", label: "Procedural — rules & how-to" },
  { value: "episodic", label: "Episodic — events & history" },
  { value: "working", label: "Working — scratchpad" },
] as const;

const EMPTY_MEM = { key: "", value: "", type: "semantic" };

export function Bot() {
  const queryClient = useQueryClient();
  const { data: bot, isLoading: botLoading } = useGetBot();
  const { data: memories, isLoading: memLoading } = useListBotMemories();
  const { data: shortTerm, isLoading: stLoading } = useListBotShortTerm();

  const policyMutation = useUpdateBotPolicy();
  const createMutation = useCreateBotMemory();
  const updateMutation = useUpdateBotMemory();
  const deleteMutation = useDeleteBotMemory();

  const [policy, setPolicy] = useState("isolated");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [dirty, setDirty] = useState(false);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memForm, setMemForm] = useState(EMPTY_MEM);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (bot) {
      setPolicy(bot.contextPolicy);
      setSystemPrompt(bot.systemPrompt ?? "");
      setDirty(false);
    }
  }, [bot]);

  const invalidatePolicy = () =>
    queryClient.invalidateQueries({ queryKey: getGetBotQueryKey() });
  const invalidateMemories = () =>
    queryClient.invalidateQueries({ queryKey: getListBotMemoriesQueryKey() });

  const handleSavePolicy = async () => {
    try {
      await policyMutation.mutateAsync({
        data: { contextPolicy: policy, systemPrompt: systemPrompt.trim() },
      });
      toast({ title: "Bot policy updated" });
      setDirty(false);
      invalidatePolicy();
    } catch (error: any) {
      toast({
        title: "Failed to update policy",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setMemForm(EMPTY_MEM);
    setIsFormOpen(true);
  };

  const openEdit = (mem: { id: string; key: string; value: string; type: string }) => {
    setEditingId(mem.id);
    setMemForm({ key: mem.key, value: mem.value, type: mem.type });
    setIsFormOpen(true);
  };

  const handleSaveMem = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          data: { key: memForm.key, value: memForm.value, type: memForm.type },
        });
        toast({ title: "Memory updated" });
      } else {
        await createMutation.mutateAsync({
          data: { key: memForm.key, value: memForm.value, type: memForm.type },
        });
        toast({ title: "Memory added" });
      }
      setIsFormOpen(false);
      setMemForm(EMPTY_MEM);
      setEditingId(null);
      invalidateMemories();
    } catch (error: any) {
      toast({
        title: "Failed to save memory",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id: string) => {
    if (deletingId) return;
    if (!confirm("Delete this memory?")) return;
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: "Memory deleted" });
      invalidateMemories();
    } catch (error: any) {
      toast({
        title: "Failed to delete memory",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (botLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BotIcon className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold font-mono">ContextOS Bot</h1>
          <p className="text-sm text-muted-foreground">
            The bot's own memory and behavior. It commands agents — it never runs
            tools itself.
          </p>
        </div>
      </div>

      <Card className="bg-card border-amber-500/30">
        <CardContent className="flex items-start gap-3 pt-6 text-sm text-muted-foreground">
          <ShieldOff className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <span>
            On every surface (Telegram, Chat, MCP) the bot can only orchestrate —
            create and run intents and manage its own memory. It cannot build, import,
            test, or execute tools directly; agents inside runs do that work.
          </span>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader className="border-b border-border/50">
          <CardTitle className="text-lg font-medium">Behavior & Context Policy</CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Context Policy</label>
            <select
              value={policy}
              onChange={(e) => {
                setPolicy(e.target.value);
                setDirty(true);
              }}
              className="w-full p-2 rounded-md border bg-background"
            >
              {CONTEXT_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Controls whether the bot's recall is limited to its own memory or also
              includes tenant-shared memory.
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setDirty(true);
              }}
              className="w-full p-2 rounded-md border bg-background min-h-[120px] font-mono text-sm"
              placeholder="Instructions that define how the bot behaves"
            />
          </div>
          <button
            onClick={handleSavePolicy}
            disabled={!dirty || policyMutation.isPending}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
          >
            {policyMutation.isPending ? "Saving..." : "Save Policy"}
          </button>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold font-mono">Long-Term Memory</h2>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" /> Add Memory
        </button>
      </div>

      {memLoading ? (
        <Skeleton className="w-full h-32" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {memories?.map((mem) => (
            <Card key={mem.id} className="bg-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                <CardTitle className="text-md font-medium truncate" title={mem.key}>
                  {mem.key}
                </CardTitle>
                <BrainCircuit className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </CardHeader>
              <CardContent className="pt-4 flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="bg-primary/10 text-primary px-2 py-1 rounded uppercase font-mono">
                    {mem.type}
                  </span>
                </div>
                <div className="text-sm text-foreground line-clamp-3 font-mono bg-muted/30 p-2 rounded">
                  {mem.value}
                </div>
                <div className="mt-auto pt-3 border-t border-border/50 flex justify-end gap-3 text-xs text-muted-foreground">
                  <button
                    onClick={() =>
                      openEdit({ id: mem.id, key: mem.key, value: mem.value, type: mem.type })
                    }
                    className="flex items-center gap-1 hover:text-primary transition-colors"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={() => handleDelete(mem.id)}
                    disabled={deletingId === mem.id}
                    className="flex items-center gap-1 hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3 h-3" />{" "}
                    {deletingId === mem.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
          {memories?.length === 0 && (
            <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
              No bot memories yet. Click "Add Memory" to curate what the bot remembers.
            </div>
          )}
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold font-mono mb-4">Recent Short-Term Memory</h2>
        {stLoading ? (
          <Skeleton className="w-full h-32" />
        ) : (
          <Card className="bg-card">
            <CardContent className="pt-6 space-y-3">
              {shortTerm?.length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-4">
                  No recent conversation history.
                </div>
              )}
              {shortTerm?.map((msg) => (
                <div
                  key={msg.id}
                  className="flex gap-3 text-sm border-b border-border/30 pb-3 last:border-0 last:pb-0"
                >
                  <span className="font-mono uppercase text-xs px-2 py-1 rounded bg-muted h-fit flex-shrink-0">
                    {msg.role}
                  </span>
                  <span className="text-foreground whitespace-pre-wrap line-clamp-3">
                    {msg.content}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Memory" : "Add Memory"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveMem} className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Key</label>
              <input
                required
                value={memForm.key}
                onChange={(e) => setMemForm({ ...memForm, key: e.target.value })}
                className="w-full p-2 rounded-md border bg-background"
                placeholder="e.g. deployment_preference"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Type</label>
              <select
                value={memForm.type}
                onChange={(e) => setMemForm({ ...memForm, type: e.target.value })}
                className="w-full p-2 rounded-md border bg-background"
              >
                {MEMORY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Value</label>
              <textarea
                required
                value={memForm.value}
                onChange={(e) => setMemForm({ ...memForm, value: e.target.value })}
                className="w-full p-2 rounded-md border bg-background min-h-[100px]"
                placeholder="What the bot should remember"
              />
            </div>
            <button
              disabled={createMutation.isPending || updateMutation.isPending}
              type="submit"
              className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
            >
              {createMutation.isPending || updateMutation.isPending
                ? "Saving..."
                : editingId
                  ? "Save Changes"
                  : "Add Memory"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
