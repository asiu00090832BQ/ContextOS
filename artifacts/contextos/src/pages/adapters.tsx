import { useState } from "react";
import { useListAdapters, getListAdaptersQueryKey, useCreateAdapter, useDeleteAdapter } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Cable, Plus, Trash2, Bot } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

export function Adapters() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListAdapters({ query: { queryKey: getListAdaptersQueryKey() } });
  
  const createMutation = useCreateAdapter();
  const deleteMutation = useDeleteAdapter();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formData, setFormData] = useState({ name: "", transport: "streamable_http", endpointUrl: "" });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({ data: formData });
      toast({ title: "Adapter created successfully" });
      setIsCreateOpen(false);
      setFormData({ name: "", transport: "streamable_http", endpointUrl: "" });
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
    } catch (error: any) {
      toast({ title: "Failed to create adapter", description: error.message, variant: "destructive" });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault(); // prevent navigation
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this adapter?")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: "Adapter deleted" });
      queryClient.invalidateQueries({ queryKey: getListAdaptersQueryKey() });
    } catch (error: any) {
      toast({ title: "Failed to delete adapter", description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">MCP Adapters</h1>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Add Adapter
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Register New Adapter</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Adapter Name</label>
                <input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full p-2 rounded-md border bg-background" placeholder="e.g. GitHub Tools" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Transport</label>
                <select value={formData.transport} onChange={e => setFormData({...formData, transport: e.target.value})} className="w-full p-2 rounded-md border bg-background">
                  <option value="streamable_http">Streamable HTTP (MCP server)</option>
                  <option value="websocket">WebSocket</option>
                  <option value="stdio">Stdio (Local)</option>
                  <option value="demo">Demo</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Endpoint URL</label>
                <input value={formData.endpointUrl} onChange={e => setFormData({...formData, endpointUrl: e.target.value})} className="w-full p-2 rounded-md border bg-background" placeholder="https://example.com/mcp" />
                <p className="text-xs text-muted-foreground">
                  After registering, open the adapter and click "Discover" to handshake and import its tools.
                </p>
              </div>
              <button disabled={createMutation.isPending} type="submit" className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium">
                {createMutation.isPending ? "Registering..." : "Register Adapter"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((adapter) => (
          <Link key={adapter.id} href={`/adapters/${adapter.id}`}>
            <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer relative group h-full">
              <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                <CardTitle className="text-lg font-medium flex items-center gap-2 min-w-0">
                  <span className="truncate">{adapter.name}</span>
                  {adapter.createdVia === "agent" && (
                    <span className="flex items-center gap-1 text-xs font-medium bg-violet-500/15 text-violet-500 px-2 py-0.5 rounded shrink-0">
                      <Bot className="w-3 h-3" /> Built by bot
                    </span>
                  )}
                </CardTitle>
                <Cable className="h-4 w-4 text-primary shrink-0" />
              </CardHeader>
              <CardContent className="pt-4 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <div className="flex gap-2 text-xs">
                    <span className="bg-muted px-2 py-1 rounded font-mono">{adapter.transport}</span>
                    <span className={`px-2 py-1 rounded font-mono uppercase ${adapter.status === 'active' ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
                      {adapter.status}
                    </span>
                  </div>
                  <button onClick={(e) => handleDelete(e, adapter.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive transition-all">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-sm text-muted-foreground mt-2">
                  Capabilities: <span className="text-foreground font-mono">{adapter.capabilityCount ?? 0}</span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No adapters found.
          </div>
        )}
      </div>
    </div>
  );
}
