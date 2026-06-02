import { useListCapabilities, getListCapabilitiesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, AlertTriangle } from "lucide-react";

export function Capabilities() {
  const { data, isLoading } = useListCapabilities();

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Capabilities Catalog</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((cap) => (
          <Card key={cap.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium truncate" title={cap.name}>{cap.name}</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-primary/10 text-primary px-2 py-1 rounded uppercase font-mono">{cap.type}</span>
                <span className={`px-2 py-1 rounded font-mono uppercase flex items-center gap-1 ${
                  cap.riskTier === 'L4' ? 'bg-destructive/20 text-destructive' : 
                  cap.riskTier === 'L3' ? 'bg-orange-500/20 text-orange-500' : 'bg-muted'
                }`}>
                  {['L3', 'L4'].includes(cap.riskTier) && <AlertTriangle className="w-3 h-3" />}
                  {cap.riskTier}
                </span>
                <span className="bg-muted px-2 py-1 rounded uppercase font-mono">{cap.actionKind}</span>
              </div>
              <div className="text-xs text-muted-foreground line-clamp-2" title={cap.description || ''}>
                {cap.description || 'No description available.'}
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No capabilities found.
          </div>
        )}
      </div>
    </div>
  );
}
