import { useListRuns, getListRunsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Activity } from "lucide-react";

function provenanceLabel(
  live?: number | null,
  stub?: number | null,
): "Live" | "Stub" | "Mixed" | null {
  const l = live ?? 0;
  const s = stub ?? 0;
  if (l > 0 && s === 0) return "Live";
  if (s > 0 && l === 0) return "Stub";
  if (l > 0 && s > 0) return "Mixed";
  return null;
}

export function ProvenanceBadge({
  live,
  stub,
}: {
  live?: number | null;
  stub?: number | null;
}) {
  const label = provenanceLabel(live, stub);
  if (!label) return null;
  return (
    <Badge variant="outline" className="font-mono text-[10px] uppercase">
      {label}
    </Badge>
  );
}

export function Runs() {
  const { data, isLoading } = useListRuns();

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Agent Runs</h1>
      </div>
      
      <div className="flex flex-col gap-4">
        {data?.map((run) => (
          <Card key={run.id} className="bg-card">
            <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-primary" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{run.intentTitle || 'Unknown Intent'}</span>
                    <ProvenanceBadge live={run.liveCallCount} stub={run.stubCallCount} />
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">{run.id}</div>
                </div>
              </div>
              
              <div className="flex items-center gap-4 text-xs font-mono">
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground">Tokens</span>
                  <span>{run.tokensUsed ?? 0}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground">Cost</span>
                  <span>${((run.costUsdMicros ?? 0) / 1000000).toFixed(4)}</span>
                </div>
                <div className={`px-3 py-1.5 rounded uppercase border ${
                  run.status === 'completed' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 
                  run.status === 'running' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' :
                  run.status === 'failed' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                  'bg-muted border-border'
                }`}>
                  {run.status}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No agent runs found.
          </div>
        )}
      </div>
    </div>
  );
}
