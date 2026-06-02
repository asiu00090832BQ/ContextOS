import { useListBlueprints, getListBlueprintsQueryKey, useListGeneratedServers, getListGeneratedServersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Network, FileJson, ServerCog } from "lucide-react";
import { Link } from "wouter";

export function Integrations() {
  const { data: blueprints, isLoading: blueprintsLoading } = useListBlueprints({ query: { queryKey: getListBlueprintsQueryKey() } });
  const { data: servers, isLoading: serversLoading } = useListGeneratedServers({ query: { queryKey: getListGeneratedServersQueryKey() } });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Integrations Pipeline</h1>
      </div>
      
      <section className="space-y-4">
        <h2 className="text-xl font-bold font-mono flex items-center gap-2">
          <FileJson className="w-5 h-5 text-primary" /> Blueprints
        </h2>
        {blueprintsLoading ? <Skeleton className="w-full h-32" /> : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {blueprints?.map((bp) => (
              <Link key={bp.id} href={`/integrations/blueprints/${bp.id}`}>
                <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                    <CardTitle className="text-md font-medium truncate">{bp.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 flex flex-col gap-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Service</span>
                      <span className="font-mono">{bp.serviceName}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Analyzed</span>
                      <span className="font-mono">{bp.analyzed ? 'Yes' : 'No'}</span>
                    </div>
                    {bp.operationCount !== undefined && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground text-xs">Operations</span>
                        <span className="font-mono">{bp.operationCount}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
            {blueprints?.length === 0 && (
              <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
                No integration blueprints defined.
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-bold font-mono flex items-center gap-2">
          <ServerCog className="w-5 h-5 text-primary" /> Generated Servers
        </h2>
        {serversLoading ? <Skeleton className="w-full h-32" /> : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {servers?.map((server) => (
              <Link key={server.id} href={`/integrations/servers/${server.id}`}>
                <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                    <CardTitle className="text-md font-medium truncate">{server.name}</CardTitle>
                    <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">v{server.version}</span>
                  </CardHeader>
                  <CardContent className="pt-4 flex flex-col gap-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Status</span>
                      <span className="font-mono uppercase text-xs px-2 py-0.5 rounded bg-muted">{server.status}</span>
                    </div>
                    {server.capabilityCount !== undefined && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground text-xs">Capabilities</span>
                        <span className="font-mono">{server.capabilityCount}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
            {servers?.length === 0 && (
              <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
                No generated servers found.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
