import { useState } from "react";
import { useListIntents, getListIntentsQueryKey, useCreateIntent, useDeleteIntent } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ListTree, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

export function Intents() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListIntents();
  
  const createMutation = useCreateIntent();
  const deleteMutation = useDeleteIntent();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formData, setFormData] = useState({ title: "", goal: "", riskTier: "L1" });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({ data: formData });
      toast({ title: "Intent created successfully" });
      setIsCreateOpen(false);
      setFormData({ title: "", goal: "", riskTier: "L1" });
      queryClient.invalidateQueries({ queryKey: getListIntentsQueryKey() });
    } catch (error: any) {
      toast({ title: "Failed to create intent", description: error.message, variant: "destructive" });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this intent?")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: "Intent deleted" });
      queryClient.invalidateQueries({ queryKey: getListIntentsQueryKey() });
    } catch (error: any) {
      toast({ title: "Failed to delete intent", description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Agent Intents</h1>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Define Intent
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Define New Intent</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Title</label>
                <input required value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} className="w-full p-2 rounded-md border bg-background" placeholder="e.g. Daily Data Sync" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Goal</label>
                <textarea required value={formData.goal} onChange={e => setFormData({...formData, goal: e.target.value})} className="w-full p-2 rounded-md border bg-background h-24" placeholder="Describe what the agent should accomplish..." />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Risk Tier</label>
                <select value={formData.riskTier} onChange={e => setFormData({...formData, riskTier: e.target.value})} className="w-full p-2 rounded-md border bg-background">
                  <option value="L1">L1 (Read-only)</option>
                  <option value="L2">L2 (Low impact writes)</option>
                  <option value="L3">L3 (High impact writes)</option>
                  <option value="L4">L4 (Destructive actions)</option>
                </select>
              </div>
              <button disabled={createMutation.isPending} type="submit" className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium">
                {createMutation.isPending ? "Creating..." : "Create Intent"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((intent) => (
          <Link key={intent.id} href={`/intents/${intent.id}`}>
            <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer group h-full relative">
              <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                <CardTitle className="text-lg font-medium">{intent.title}</CardTitle>
                <ListTree className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent className="pt-4 flex flex-col gap-3">
                <div className="text-sm text-foreground line-clamp-2 h-10">
                  {intent.goal}
                </div>
                <div className="flex justify-between items-center mt-2 border-t border-border/50 pt-3">
                   <div className="flex gap-2">
                     <span className="text-xs font-mono bg-muted px-2 py-1 rounded uppercase">
                      {intent.status}
                     </span>
                     <span className={`text-xs font-mono px-2 py-1 rounded ${['L3', 'L4'].includes(intent.riskTier) ? 'bg-destructive/20 text-destructive' : 'bg-primary/20 text-primary'}`}>
                      {intent.riskTier}
                     </span>
                   </div>
                   <button onClick={(e) => handleDelete(e, intent.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive transition-all">
                      <Trash2 className="w-4 h-4" />
                   </button>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No intents defined.
          </div>
        )}
      </div>
    </div>
  );
}
