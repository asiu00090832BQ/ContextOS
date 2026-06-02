import { useListModelEndpoints, getListModelEndpointsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerCog, Activity } from "lucide-react";

export function ModelEndpoints() {
  const { data, isLoading } = useListModelEndpoints({ query: { queryKey: getListModelEndpointsQueryKey() } });

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Model Endpoints</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((endpoint) => (
          <Card key={endpoint.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-lg font-medium flex items-center gap-2">
                <ServerCog className="h-4 w-4 text-primary" />
                {endpoint.name}
              </CardTitle>
              {endpoint.isDefault && (
                <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded font-mono uppercase">Default</span>
              )}
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <div className="text-muted-foreground">Provider</div>
                <div className="font-mono uppercase">{endpoint.providerType}</div>
                
                <div className="text-muted-foreground">Model</div>
                <div className="font-mono">{endpoint.modelName}</div>
                
                <div className="text-muted-foreground">Status</div>
                <div className="font-mono uppercase flex items-center gap-1">
                  <div className={`w-2 h-2 rounded-full ${endpoint.status === 'active' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                  {endpoint.status}
                </div>
              </div>
              
              {endpoint.apiKeyMasked && (
                <div className="mt-2 text-xs font-mono bg-muted/30 p-2 rounded border border-border/50 text-muted-foreground flex justify-between items-center">
                  <span>API Key: {endpoint.apiKeyMasked}</span>
                </div>
              )}
              
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No model endpoints defined.
          </div>
        )}
      </div>
    </div>
  );
}
