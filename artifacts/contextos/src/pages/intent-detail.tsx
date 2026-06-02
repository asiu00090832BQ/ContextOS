import { useRoute, useLocation } from "wouter";
import { useGetIntent, getGetIntentQueryKey, useStartRun } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ListTree, Play, Target, ShieldAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function IntentDetail() {
  const [, params] = useRoute("/intents/:id");
  const [, setLocation] = useLocation();
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: intent, isLoading } = useGetIntent(id, { query: { enabled: !!id, queryKey: getGetIntentQueryKey(id) } });
  const startRunMutation = useStartRun();

  const handleStartRun = async () => {
    try {
      const run = await startRunMutation.mutateAsync({ id, data: { orchestrationMode: 'autonomous' } });
      toast({ title: "Run started", description: `Run ${run.id.slice(0, 8)} initialized.` });
      setLocation(`/runs/${run.id}`);
    } catch (e: any) {
      toast({ title: "Failed to start run", description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  if (!intent) {
    return <div className="p-8 text-center text-muted-foreground">Intent not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div className="flex-1 pr-4">
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <ListTree className="h-6 w-6 text-primary" /> {intent.title}
          </h1>
          <div className="flex gap-2 mt-2">
            <span className="text-xs bg-muted px-2 py-1 rounded font-mono uppercase">{intent.status}</span>
            <span className={`text-xs px-2 py-1 rounded font-mono uppercase flex items-center gap-1 ${['L3', 'L4'].includes(intent.riskTier) ? 'bg-destructive/20 text-destructive' : 'bg-primary/20 text-primary'}`}>
              <ShieldAlert className="w-3 h-3" /> {intent.riskTier}
            </span>
          </div>
        </div>
        <button 
          onClick={handleStartRun}
          disabled={startRunMutation.isPending || intent.status !== 'active'}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Play className="w-4 h-4" /> Start Run
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><Target className="w-5 h-5 text-muted-foreground"/> Goal & Constraints</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Goal</div>
              <div className="text-sm">{intent.goal}</div>
            </div>
            {intent.constraints && (
              <div>
                <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Constraints</div>
                <div className="text-sm bg-muted/20 p-2 rounded border border-border/50">{intent.constraints}</div>
              </div>
            )}
            {intent.successCriteria && (
              <div>
                <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Success Criteria</div>
                <div className="text-sm bg-muted/20 p-2 rounded border border-border/50">{intent.successCriteria}</div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-lg">Resource Limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Budget (Tokens)</span>
              <span className="font-mono">{intent.budgetTokens?.toLocaleString() || 'Unlimited'}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Budget (USD)</span>
              <span className="font-mono">{intent.budgetUsd ? `$${(intent.budgetUsd / 1000000).toFixed(2)}` : 'Unlimited'}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Max Steps</span>
              <span className="font-mono">{intent.maxSteps || 'Unlimited'}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-muted-foreground">Historical Runs</span>
              <span className="font-mono">{intent.runCount ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
