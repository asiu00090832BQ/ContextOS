import { useRoute } from "wouter";
import { useGetRun, getGetRunQueryKey, usePauseRun, useResumeRun, useCancelRun, useListRunEvents } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Pause, Play, Square, FileText, Cpu, CheckSquare } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function RunDetail() {
  const [, params] = useRoute("/runs/:id");
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: run, isLoading } = useGetRun(id, { query: { enabled: !!id, queryKey: getGetRunQueryKey(id), refetchInterval: 5000 } });
  
  const pauseMutation = usePauseRun();
  const resumeMutation = useResumeRun();
  const cancelMutation = useCancelRun();

  const handleAction = async (action: 'pause' | 'resume' | 'cancel') => {
    try {
      if (action === 'pause') await pauseMutation.mutateAsync({ id });
      if (action === 'resume') await resumeMutation.mutateAsync({ id });
      if (action === 'cancel') await cancelMutation.mutateAsync({ id });
      toast({ title: `Run ${action}d` });
      queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(id) });
    } catch (e: any) {
      toast({ title: `Failed to ${action} run`, description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!run) return <div className="p-8 text-center text-muted-foreground">Run not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" /> Run: {run.id.slice(0,8)}
          </h1>
          <div className="text-sm text-muted-foreground mt-1">Intent: {run.intentTitle || run.intentId}</div>
        </div>
        <div className="flex gap-2">
          {run.status === 'running' && (
            <button onClick={() => handleAction('pause')} className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80">
              <Pause className="w-4 h-4" /> Pause
            </button>
          )}
          {run.status === 'paused' && (
            <button onClick={() => handleAction('resume')} className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90">
              <Play className="w-4 h-4" /> Resume
            </button>
          )}
          {['running', 'paused', 'pending'].includes(run.status) && (
            <button onClick={() => handleAction('cancel')} className="flex items-center gap-2 px-3 py-1.5 bg-destructive text-destructive-foreground rounded text-sm hover:bg-destructive/90">
              <Square className="w-4 h-4" /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Status</div>
            <div className={`font-mono font-bold uppercase ${
              run.status === 'completed' ? 'text-green-500' : 
              run.status === 'running' ? 'text-blue-500' :
              run.status === 'failed' ? 'text-destructive' : ''
            }`}>{run.status}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Mode</div>
            <div className="font-mono uppercase">{run.orchestrationMode}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Tokens Used</div>
            <div className="font-mono">{run.tokensUsed?.toLocaleString() || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Cost</div>
            <div className="font-mono">${((run.costUsdMicros ?? 0) / 1000000).toFixed(4)}</div>
          </CardContent>
        </Card>
      </div>

      {run.summary && (
        <Card className="bg-muted/10">
          <CardContent className="p-4 text-sm">
            {run.summary}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="space-y-4">
          <h3 className="text-lg font-bold font-mono flex items-center gap-2"><CheckSquare className="w-5 h-5 text-primary"/> Actions Taken</h3>
          <div className="space-y-2">
            {run.actions?.map(action => (
              <div key={action.id} className="bg-card border border-border/50 p-3 rounded-lg text-sm">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium font-mono text-primary">{action.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded uppercase font-mono ${
                    action.status === 'success' ? 'bg-green-500/10 text-green-500' : 
                    action.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted'
                  }`}>{action.status}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate font-mono">
                  {JSON.stringify(action.input)}
                </div>
              </div>
            ))}
            {(!run.actions || run.actions.length === 0) && <div className="text-sm text-muted-foreground italic">No actions recorded.</div>}
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-lg font-bold font-mono flex items-center gap-2"><Cpu className="w-5 h-5 text-primary"/> Agent Runs</h3>
          <div className="space-y-2">
            {run.agentRuns?.map(ar => (
              <div key={ar.id} className="bg-card border border-border/50 p-3 rounded-lg text-sm">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-medium">{ar.agentName}</span>
                  <span className="text-xs font-mono bg-muted px-2 rounded uppercase">{ar.status}</span>
                </div>
                <div className="text-xs text-muted-foreground uppercase font-mono mb-2">{ar.role}</div>
                <div className="text-xs text-muted-foreground truncate">{ar.task}</div>
              </div>
            ))}
            {(!run.agentRuns || run.agentRuns.length === 0) && <div className="text-sm text-muted-foreground italic">No sub-runs recorded.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
