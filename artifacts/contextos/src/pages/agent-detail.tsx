import { useRoute } from "wouter";
import { useGetAgent, getGetAgentQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu, ServerCog, Shield } from "lucide-react";

export function AgentDetail() {
  const [, params] = useRoute("/agents/:id");
  const id = params?.id || "";

  const { data: agent, isLoading } = useGetAgent(id, { query: { enabled: !!id, queryKey: getGetAgentQueryKey(id) } });

  if (isLoading) return <Skeleton className="w-full h-64" />;
  if (!agent) return <div className="p-8 text-center text-muted-foreground">Agent not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
            <Cpu className="h-6 w-6 text-primary" /> {agent.name}
          </h1>
          <div className="text-sm text-muted-foreground mt-1">{agent.description}</div>
        </div>
        <div className={`px-3 py-1 rounded text-xs font-mono uppercase ${agent.isActive ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
          {agent.isActive ? 'Active' : 'Inactive'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><Shield className="w-5 h-5 text-muted-foreground"/> Identity & Role</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Role</div>
              <div className="text-sm font-mono bg-muted/30 p-2 rounded">{agent.role}</div>
            </div>
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase mb-1">System Prompt</div>
              <div className="text-sm bg-muted/30 p-3 rounded font-mono whitespace-pre-wrap text-muted-foreground h-48 overflow-y-auto">
                {agent.systemPrompt || 'No system prompt defined.'}
              </div>
            </div>
            <div>
               <div className="text-xs font-mono text-muted-foreground uppercase mb-1">Context Policy</div>
               <div className="text-sm font-mono bg-muted/30 p-2 rounded uppercase">{agent.contextPolicy}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><ServerCog className="w-5 h-5 text-muted-foreground"/> Model Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {agent.modelPolicy ? (
              <>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Primary Endpoint</span>
                  <span className="font-mono text-sm">{agent.modelPolicy.primaryEndpointId || 'None'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Fallback Endpoint</span>
                  <span className="font-mono text-sm">{agent.modelPolicy.fallbackEndpointId || 'None'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Temperature</span>
                  <span className="font-mono text-sm">{(agent.modelPolicy.temperature ?? 0) / 100}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground">Max Tokens</span>
                  <span className="font-mono text-sm">{agent.modelPolicy.maxTokens || 'Default'}</span>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground italic p-4 bg-muted/10 rounded">No specific model policy attached. Using platform defaults.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
