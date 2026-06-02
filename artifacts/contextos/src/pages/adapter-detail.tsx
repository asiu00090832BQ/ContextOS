import { useRoute } from "wouter";
import { useGetAdapter, getGetAdapterQueryKey, useDiscoverAdapter, useTestAdapter } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Cable, Search, Activity, Zap, ServerCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function AdapterDetail() {
  const [, params] = useRoute("/adapters/:id");
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: adapter, isLoading } = useGetAdapter(id, { query: { enabled: !!id, queryKey: getGetAdapterQueryKey(id) } });
  
  const discoverMutation = useDiscoverAdapter();
  const testMutation = useTestAdapter();

  const handleDiscover = async () => {
    try {
      await discoverMutation.mutateAsync({ id });
      toast({ title: "Discovery initiated", description: "Adapter capabilities are being updated." });
      queryClient.invalidateQueries({ queryKey: getGetAdapterQueryKey(id) });
    } catch (e: any) {
      toast({ title: "Discovery failed", description: e.message, variant: "destructive" });
    }
  };

  const handleTest = async () => {
    try {
      await testMutation.mutateAsync({ id });
      toast({ title: "Health test initiated", description: "Testing adapter connectivity." });
      queryClient.invalidateQueries({ queryKey: getGetAdapterQueryKey(id) });
    } catch (e: any) {
      toast({ title: "Health test failed", description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  if (!adapter) {
    return <div className="p-8 text-center text-muted-foreground">Adapter not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Cable className="h-6 w-6 text-primary" /> {adapter.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{adapter.description}</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={handleDiscover}
            disabled={discoverMutation.isPending}
            className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80 disabled:opacity-50"
          >
            <Search className="w-4 h-4" /> Discover
          </button>
          <button 
            onClick={handleTest}
            disabled={testMutation.isPending}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            <Activity className="w-4 h-4" /> Test Health
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-lg font-mono uppercase ${adapter.status === 'active' ? 'text-green-500' : ''}`}>{adapter.status}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Transport</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-mono">{adapter.transport} <span className="text-sm text-muted-foreground">v{adapter.protocolVersion}</span></div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-mono">{adapter.capabilityCount ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-xl font-bold font-mono mt-8 border-b border-border/50 pb-2">Capabilities</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {adapter.capabilities?.map((cap) => (
          <Card key={cap.id} className="bg-muted/10 border-border/50">
            <CardContent className="p-4 flex flex-col gap-2">
               <div className="flex justify-between items-center">
                 <div className="font-medium text-sm flex items-center gap-2">
                   <Zap className="w-4 h-4 text-primary" /> {cap.name}
                 </div>
                 <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded font-mono uppercase">{cap.type}</span>
               </div>
               <div className="text-xs text-muted-foreground">{cap.description || 'No description'}</div>
            </CardContent>
          </Card>
        ))}
        {(!adapter.capabilities || adapter.capabilities.length === 0) && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No capabilities discovered yet.
          </div>
        )}
      </div>
    </div>
  );
}
