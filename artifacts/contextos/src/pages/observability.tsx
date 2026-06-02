import { useListTraces, getListTracesQueryKey, useGetObservabilityMetrics, getGetObservabilityMetricsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Microscope, Activity } from "lucide-react";
import { Link } from "wouter";

export function Observability() {
  const { data: traces, isLoading: tracesLoading } = useListTraces();
  const { data: metrics, isLoading: metricsLoading } = useGetObservabilityMetrics({ level: 'models' }, { query: { queryKey: getGetObservabilityMetricsQueryKey({ level: 'models' }) } });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Observability</h1>
      </div>
      
      {metricsLoading ? <Skeleton className="w-full h-32" /> : (
        <Card className="bg-card">
          <CardHeader>
             <CardTitle className="text-lg">Model Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
               {metrics?.rows.map((row, i) => (
                 <div key={i} className="flex flex-col p-3 rounded bg-muted/30 border border-border/50">
                    <div className="text-xs font-mono text-muted-foreground truncate">{row.label}</div>
                    <div className="text-xl font-bold mt-1">{row.count} <span className="text-xs text-muted-foreground font-normal">calls</span></div>
                    {row.avgLatencyMs !== undefined && (
                      <div className="text-xs text-muted-foreground mt-1">{row.avgLatencyMs}ms avg</div>
                    )}
                 </div>
               ))}
               {(!metrics?.rows || metrics.rows.length === 0) && (
                 <div className="col-span-full text-sm text-muted-foreground">No metrics available.</div>
               )}
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="text-xl font-bold font-mono mt-8">Recent Traces</h2>
      <div className="flex flex-col gap-2">
        {tracesLoading ? <Skeleton className="w-full h-64" /> : traces?.map((trace) => (
          <Link key={trace.id} href={`/observability/traces/${trace.id}`}>
            <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Microscope className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-medium text-sm">{trace.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{trace.id}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-4 text-xs font-mono">
                  <div className="flex flex-col items-end">
                    <span className="text-muted-foreground">Duration</span>
                    <span>{trace.durationMs ?? 0}ms</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-muted-foreground">Tokens</span>
                    <span>{trace.totalTokens ?? 0}</span>
                  </div>
                  <div className={`px-2 py-1 rounded uppercase ${
                    trace.status === 'success' ? 'bg-green-500/10 text-green-500' : 
                    trace.status === 'error' ? 'bg-destructive/10 text-destructive' :
                    'bg-muted'
                  }`}>
                    {trace.status}
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {traces?.length === 0 && (
          <div className="p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No traces recorded.
          </div>
        )}
      </div>
    </div>
  );
}
