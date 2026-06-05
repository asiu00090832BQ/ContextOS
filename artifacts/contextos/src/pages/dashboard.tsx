import {
  useGetDashboard,
  getGetDashboardQueryKey,
  useReviewBotServers,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Cable, Zap, Cpu, Bot, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";

export function Dashboard() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data, isLoading } = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const reviewMutation = useReviewBotServers();

  const markReviewed = async () => {
    try {
      await reviewMutation.mutateAsync();
    } finally {
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  };

  const handleReview = async () => {
    await markReviewed();
    navigate("/servers");
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold font-mono">Platform Telemetry</h1>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold font-mono">Platform Telemetry</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Runs</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.activeRunCount}</div>
          </CardContent>
        </Card>
        
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Adapters</CardTitle>
            <Cable className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.adapterCount}</div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Capabilities</CardTitle>
            <Zap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.capabilityCount}</div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Agents</CardTitle>
            <Cpu className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.agentCount}</div>
          </CardContent>
        </Card>
      </div>

      {(data.newBotServerCount ?? 0) > 0 && (
        <Card className="border-violet-500/40 bg-violet-500/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-violet-500/15 p-2">
                <Bot className="h-5 w-5 text-violet-500" />
              </div>
              <div>
                <div className="font-medium">
                  The assistant built{" "}
                  {data.newBotServerCount === 1
                    ? "a new web service"
                    : `${data.newBotServerCount} new web services`}{" "}
                  for you
                </div>
                <div className="text-sm text-muted-foreground">
                  {(data.recentBotServers ?? [])
                    .filter((s) => s.isNew)
                    .slice(0, 3)
                    .map((s) => s.name)
                    .join(", ") || "Review them to make sure they look right."}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void markReviewed()}
                disabled={reviewMutation.isPending}
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                onClick={() => void handleReview()}
                disabled={reviewMutation.isPending}
                className="flex items-center gap-2 rounded-md bg-violet-500 px-3 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                Review in MCP Servers <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentRuns && data.recentRuns.length > 0 ? (
              <div className="space-y-4">
                {data.recentRuns.map(run => (
                  <div key={run.id} className="flex justify-between items-center p-3 rounded bg-muted/30">
                    <div>
                      <div className="font-medium text-sm">{run.intentTitle || 'Unknown Intent'}</div>
                      <div className="text-xs text-muted-foreground font-mono">{run.id.slice(0,8)}</div>
                    </div>
                    <div className="text-xs font-mono uppercase px-2 py-1 rounded bg-muted border">
                      {run.status}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No recent runs</div>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Audit Log</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentAudit && data.recentAudit.length > 0 ? (
              <div className="space-y-4">
                {data.recentAudit.map(log => (
                  <div key={log.id} className="flex flex-col p-3 rounded bg-muted/30">
                    <div className="text-xs font-mono text-primary mb-1">{log.action}</div>
                    <div className="text-sm">{log.summary}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No recent audit logs</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
