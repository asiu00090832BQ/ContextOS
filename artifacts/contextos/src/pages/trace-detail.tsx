import { useRoute } from "wouter";
import { useGetTrace, getGetTraceQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Microscope, Layers, Activity, Cpu, ServerCog, Database, Clock, Play } from "lucide-react";

export function TraceDetail() {
  const [, params] = useRoute("/observability/traces/:id");
  const id = params?.id || "";

  const { data: trace, isLoading } = useGetTrace(id, { query: { enabled: !!id, queryKey: getGetTraceQueryKey(id) } });

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!trace) return <div className="p-8 text-center text-muted-foreground">Trace not found.</div>;

  // Build a tree from flat observations
  const rootObservations = trace.observations?.filter(o => !o.parentObservationId) || [];
  const childrenMap = new Map<string, typeof trace.observations>();
  trace.observations?.forEach(o => {
    if (o.parentObservationId) {
      if (!childrenMap.has(o.parentObservationId)) childrenMap.set(o.parentObservationId, []);
      childrenMap.get(o.parentObservationId)!.push(o);
    }
  });

  const getIconForType = (type: string) => {
    switch(type) {
      case 'run': return <Play className="w-4 h-4 text-primary" />;
      case 'agent_run': return <Cpu className="w-4 h-4 text-blue-400" />;
      case 'model_call': return <ServerCog className="w-4 h-4 text-purple-400" />;
      case 'tool_call': return <Activity className="w-4 h-4 text-green-400" />;
      case 'context_retrieval': return <Database className="w-4 h-4 text-yellow-400" />;
      default: return <Layers className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const renderObservationNode = (obs: NonNullable<typeof trace.observations>[0], depth = 0) => {
    const children = childrenMap.get(obs.id) || [];
    const indent = depth * 24;

    return (
      <div key={obs.id} className="flex flex-col border-b border-border/50 last:border-0">
        <div className="flex items-center justify-between p-3 hover:bg-muted/10 transition-colors" style={{ paddingLeft: `${indent + 12}px` }}>
          <div className="flex items-center gap-3">
             {getIconForType(obs.type)}
             <div>
               <div className="font-mono text-sm font-medium">{obs.name}</div>
               <div className="flex gap-2 text-xs mt-0.5">
                 <span className="text-muted-foreground uppercase">{obs.type} • {obs.layer}</span>
                 <span className={`uppercase ${obs.status === 'success' ? 'text-green-500' : obs.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{obs.status}</span>
               </div>
             </div>
          </div>
          
          <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
             {(obs.type === 'model_call' || obs.type === 'agent_run') && obs.metrics?.usedStub !== undefined && (
               <span
                 className={`px-2 py-0.5 rounded uppercase tracking-wide text-[10px] font-medium ${
                   obs.metrics.usedStub
                     ? 'bg-amber-500/10 text-amber-500 border border-amber-500/30'
                     : 'bg-green-500/10 text-green-500 border border-green-500/30'
                 }`}
                 title={obs.metrics.usedStub
                   ? 'Output was produced by the deterministic simulated stub (no live model endpoint was reached).'
                   : 'Output came from a real configured model endpoint.'}
               >
                 {obs.metrics.usedStub ? 'Stub' : 'Live'}
               </span>
             )}
             {obs.metrics?.latencyMs !== undefined && (
               <div className="flex items-center gap-1"><Clock className="w-3 h-3"/> {obs.metrics.latencyMs}ms</div>
             )}
             {obs.metrics?.totalTokens !== undefined && (
               <div>{obs.metrics.totalTokens} tkn</div>
             )}
             {obs.metrics?.costUsdMicros !== undefined && obs.metrics.costUsdMicros > 0 && (
               <div>${(obs.metrics.costUsdMicros / 1000000).toFixed(4)}</div>
             )}
          </div>
        </div>
        
        {children.map(child => renderObservationNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Microscope className="h-6 w-6 text-primary" /> Trace: {trace.name}
          </h1>
          <div className="text-sm text-muted-foreground mt-1 font-mono">{trace.id}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Status</div>
            <div className={`font-mono uppercase ${trace.status === 'success' ? 'text-green-500' : 'text-destructive'}`}>{trace.status}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Root Type</div>
            <div className="font-mono uppercase">{trace.rootType}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Duration</div>
            <div className="font-mono">{trace.durationMs ?? 0}ms</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Total Tokens</div>
            <div className="font-mono">{trace.totalTokens?.toLocaleString() || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Total Cost</div>
            <div className="font-mono">${((trace.totalCostUsdMicros ?? 0) / 1000000).toFixed(4)}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card overflow-hidden">
        <CardHeader className="bg-muted/20 border-b border-border/50 pb-3">
          <CardTitle className="text-md font-mono flex items-center gap-2">
             <Layers className="w-4 h-4"/> Observation Tree ({trace.observationCount})
          </CardTitle>
        </CardHeader>
        <div className="flex flex-col bg-background/50">
          {rootObservations.map(obs => renderObservationNode(obs, 0))}
          {rootObservations.length === 0 && (
             <div className="p-8 text-center text-muted-foreground text-sm">No observations recorded for this trace.</div>
          )}
        </div>
      </Card>

    </div>
  );
}
