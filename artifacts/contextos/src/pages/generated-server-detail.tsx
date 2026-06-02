import { useRoute } from "wouter";
import { useGetGeneratedServer, getGetGeneratedServerQueryKey, useTestGeneratedServer, useApproveGeneratedServer, useDeployGeneratedServer, useRegisterGeneratedServer, useRegenerateGeneratedServer } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerCog, Activity, CloudUpload, Cable, RefreshCw, Zap, CheckCircle2, XCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function GeneratedServerDetail() {
  const [, params] = useRoute("/integrations/servers/:id");
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: server, isLoading } = useGetGeneratedServer(id, { query: { enabled: !!id, queryKey: getGetGeneratedServerQueryKey(id) } });
  
  const testMutation = useTestGeneratedServer();
  const approveMutation = useApproveGeneratedServer();
  const deployMutation = useDeployGeneratedServer();
  const registerMutation = useRegisterGeneratedServer();
  const regenerateMutation = useRegenerateGeneratedServer();

  const handleAction = async (action: 'test' | 'approve' | 'deploy' | 'register' | 'regenerate') => {
    try {
      if (action === 'test') await testMutation.mutateAsync({ id });
      if (action === 'approve') await approveMutation.mutateAsync({ id });
      if (action === 'deploy') await deployMutation.mutateAsync({ id });
      if (action === 'register') await registerMutation.mutateAsync({ id });
      if (action === 'regenerate') await regenerateMutation.mutateAsync({ id, data: { reason: "Manual regeneration" } });
      
      toast({ title: `Server ${action} initiated` });
      queryClient.invalidateQueries({ queryKey: getGetGeneratedServerQueryKey(id) });
    } catch (e: any) {
      toast({ title: `Failed to ${action} server`, description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!server) return <div className="p-8 text-center text-muted-foreground">Server not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <ServerCog className="h-6 w-6 text-primary" /> {server.name}
          </h1>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
            <span className="font-mono">v{server.version}</span>
            <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase ${
              server.status === 'ready' ? 'bg-green-500/20 text-green-500' :
              server.status === 'failed' ? 'bg-destructive/20 text-destructive' : 'bg-muted'
            }`}>{server.status}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => handleAction('test')} disabled={testMutation.isPending} className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80">
            <Activity className="w-4 h-4" /> Test
          </button>
          {server.humanReviewRequired && !server.approved && (
            <button onClick={() => handleAction('approve')} disabled={approveMutation.isPending} className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 text-amber-500 rounded text-sm hover:bg-amber-500/30 disabled:opacity-50">
              <ShieldCheck className="w-4 h-4" /> Approve
            </button>
          )}
          <button onClick={() => handleAction('deploy')} disabled={deployMutation.isPending || (server.humanReviewRequired && !server.approved)} className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80 disabled:opacity-50" title={server.humanReviewRequired && !server.approved ? "Requires human approval before deployment" : undefined}>
            <CloudUpload className="w-4 h-4" /> Deploy
          </button>
          <button onClick={() => handleAction('register')} disabled={registerMutation.isPending || server.deploymentStatus !== 'deployed'} className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50">
            <Cable className="w-4 h-4" /> Register Adapter
          </button>
          <button onClick={() => handleAction('regenerate')} disabled={regenerateMutation.isPending} className="flex items-center gap-2 px-3 py-1.5 bg-secondary/50 text-secondary-foreground rounded text-sm hover:bg-secondary/80 border border-border/50">
            <RefreshCw className="w-4 h-4" /> Regenerate
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Capabilities</div>
            <div className="font-mono">{server.capabilityCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Tests Passed</div>
            <div className="font-mono text-green-500">{server.testsPassed ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Tests Failed</div>
            <div className={`font-mono ${(server.testsFailed ?? 0) > 0 ? 'text-destructive' : ''}`}>{server.testsFailed ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Deployment</div>
            <div className="font-mono uppercase">{server.deploymentStatus || 'Pending'}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="space-y-4">
          <h3 className="text-lg font-bold font-mono flex items-center gap-2"><Zap className="w-5 h-5 text-primary"/> Synthesized Capabilities</h3>
          <div className="space-y-2">
            {server.capabilities?.map((cap) => (
              <div key={cap.id} className="bg-card border border-border/50 p-3 rounded-lg text-sm">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-medium font-mono text-primary truncate pr-2">{cap.name}</span>
                  <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono uppercase shrink-0">{cap.type}</span>
                </div>
                <div className="flex gap-2 text-xs mb-2">
                  <span className="text-muted-foreground font-mono bg-muted/50 px-1.5 rounded">{cap.httpMethod} {cap.sourceOperation}</span>
                  <span className={`font-mono px-1.5 rounded ${cap.riskTier === 'L4' ? 'bg-destructive/20 text-destructive' : 'bg-muted/50'}`}>{cap.riskTier}</span>
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2">{cap.description}</div>
              </div>
            ))}
            {(!server.capabilities || server.capabilities.length === 0) && (
              <div className="text-sm text-muted-foreground italic bg-muted/10 p-4 rounded border border-dashed">No capabilities synthesized.</div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-lg font-bold font-mono flex items-center gap-2"><Activity className="w-5 h-5 text-primary"/> Integration Tests</h3>
          <div className="space-y-2">
            {server.tests?.map((test) => (
              <div key={test.id} className="bg-card border border-border/50 p-3 rounded-lg text-sm">
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-2 font-mono">
                    {test.status === 'passed' ? <CheckCircle2 className="w-4 h-4 text-green-500"/> : 
                     test.status === 'failed' ? <XCircle className="w-4 h-4 text-destructive"/> :
                     <Activity className="w-4 h-4 text-muted-foreground"/>}
                    {test.name}
                  </div>
                  <span className="text-xs text-muted-foreground font-mono">{test.durationMs}ms</span>
                </div>
                {test.assertion && <div className="text-xs text-muted-foreground font-mono bg-muted/30 p-1 rounded mt-2 truncate">Assert: {test.assertion}</div>}
              </div>
            ))}
            {(!server.tests || server.tests.length === 0) && (
              <div className="text-sm text-muted-foreground italic bg-muted/10 p-4 rounded border border-dashed">No tests generated.</div>
            )}
          </div>

          {server.securityReview && (
             <div className="mt-6">
                <h3 className="text-lg font-bold font-mono flex items-center gap-2 mb-4"><ShieldAlert className="w-5 h-5 text-primary"/> Security Review</h3>
                <div className="bg-muted/10 p-4 rounded-lg border border-border/50">
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                    {JSON.stringify(server.securityReview, null, 2)}
                  </pre>
                </div>
             </div>
          )}
        </section>
      </div>
      
      {server.serverCode && (
        <section className="space-y-4 mt-8">
           <h3 className="text-lg font-bold font-mono flex items-center gap-2">Generated Source Code</h3>
           <div className="bg-[#0d1117] p-4 rounded-lg border border-border/50 overflow-x-auto max-h-96 overflow-y-auto">
             <pre className="text-xs font-mono text-blue-300">
               {server.serverCode}
             </pre>
           </div>
        </section>
      )}

    </div>
  );
}
