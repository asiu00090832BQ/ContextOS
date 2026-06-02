import { useRoute } from "wouter";
import { useGetBlueprint, getGetBlueprintQueryKey, useAnalyzeBlueprint, useSynthesizeServer } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FileJson, Search, Wand2, Terminal, Network } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

export function BlueprintDetail() {
  const [, params] = useRoute("/integrations/blueprints/:id");
  const [, setLocation] = useLocation();
  const id = params?.id || "";
  const queryClient = useQueryClient();

  const { data: bp, isLoading } = useGetBlueprint(id, { query: { enabled: !!id, queryKey: getGetBlueprintQueryKey(id) } });
  
  const analyzeMutation = useAnalyzeBlueprint();
  const synthesizeMutation = useSynthesizeServer();

  const handleAnalyze = async () => {
    try {
      await analyzeMutation.mutateAsync({ id });
      toast({ title: "Analysis complete", description: "Blueprint structure analyzed successfully." });
      queryClient.invalidateQueries({ queryKey: getGetBlueprintQueryKey(id) });
    } catch (e: any) {
      toast({ title: "Analysis failed", description: e.message, variant: "destructive" });
    }
  };

  const handleSynthesize = async () => {
    try {
      const server = await synthesizeMutation.mutateAsync({ id });
      toast({ title: "Server synthesized", description: "MCP server code generated successfully." });
      setLocation(`/integrations/servers/${server.id}`);
    } catch (e: any) {
      toast({ title: "Synthesis failed", description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!bp) return <div className="p-8 text-center text-muted-foreground">Blueprint not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <FileJson className="h-6 w-6 text-primary" /> {bp.name}
          </h1>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
            <Network className="w-4 h-4"/> {bp.serviceName} 
            <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono uppercase">{bp.sourceType}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={handleAnalyze}
            disabled={analyzeMutation.isPending}
            className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80 disabled:opacity-50"
          >
            <Search className="w-4 h-4" /> Analyze
          </button>
          <button 
            onClick={handleSynthesize}
            disabled={synthesizeMutation.isPending || !bp.analyzed}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50"
            title={!bp.analyzed ? "Must analyze blueprint first" : ""}
          >
            <Wand2 className="w-4 h-4" /> Synthesize Server
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Status</div>
            <div className={`font-mono uppercase ${bp.analyzed ? 'text-green-500' : 'text-yellow-500'}`}>
              {bp.analyzed ? 'Analyzed' : 'Raw'}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Operations</div>
            <div className="font-mono">{bp.operationCount ?? 'Unknown'}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Confidence</div>
            <div className="font-mono">{bp.generationConfidenceScore ? `${(bp.generationConfidenceScore * 100).toFixed(0)}%` : 'Unknown'}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Human Review</div>
            <div className={`font-mono uppercase ${bp.humanReviewRequired ? 'text-destructive' : 'text-green-500'}`}>
              {bp.humanReviewRequired ? 'Required' : 'Optional'}
            </div>
          </CardContent>
        </Card>
      </div>

      {bp.sourceUrl && (
        <Card className="bg-muted/10">
           <CardHeader>
             <CardTitle className="text-sm font-mono text-muted-foreground">Source URL</CardTitle>
           </CardHeader>
           <CardContent className="pt-0">
              <a href={bp.sourceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline font-mono text-sm break-all">
                {bp.sourceUrl}
              </a>
           </CardContent>
        </Card>
      )}

      {bp.normalized && (
        <section className="space-y-4">
          <h3 className="text-lg font-bold font-mono flex items-center gap-2"><Terminal className="w-5 h-5 text-primary"/> Normalized Structure</h3>
          <div className="bg-muted/30 p-4 rounded-lg border border-border/50 overflow-x-auto">
            <pre className="text-xs font-mono text-muted-foreground">
              {JSON.stringify(bp.normalized, null, 2)}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}
