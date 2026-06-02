import { useListAgents, getListAgentsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu, Settings2 } from "lucide-react";
import { Link } from "wouter";

export function Agents() {
  const { data, isLoading } = useListAgents({ query: { queryKey: getListAgentsQueryKey() } });

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Agent Roster</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((agent) => (
          <Link key={agent.id} href={`/agents/${agent.id}`}>
            <Card className="bg-card hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                <CardTitle className="text-lg font-medium">{agent.name}</CardTitle>
                <Cpu className={`h-4 w-4 ${agent.isActive ? 'text-primary' : 'text-muted-foreground'}`} />
              </CardHeader>
              <CardContent className="pt-4 flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="bg-primary/10 text-primary px-2 py-1 rounded font-mono">{agent.role}</span>
                  <span className={`px-2 py-1 rounded font-mono uppercase ${agent.isActive ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
                    {agent.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground line-clamp-2">
                  {agent.description || 'No description.'}
                </div>
                
                <div className="mt-auto pt-3 border-t border-border/50 flex justify-between items-center text-xs text-muted-foreground">
                   <div className="flex items-center gap-1 font-mono uppercase">
                     <Settings2 className="w-3 h-3" /> {agent.contextPolicy}
                   </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No agents found.
          </div>
        )}
      </div>
    </div>
  );
}
