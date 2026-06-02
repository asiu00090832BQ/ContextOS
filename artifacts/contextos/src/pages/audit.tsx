import { useListAudit, getListAuditQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, ShieldAlert } from "lucide-react";

export function Audit() {
  const { data, isLoading } = useListAudit();

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Immutable Audit Log</h1>
      </div>
      
      <div className="flex flex-col gap-2">
        {data?.map((log) => (
          <Card key={log.id} className="bg-card">
            <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {log.riskTier === 'L4' || log.riskTier === 'L3' ? <ShieldAlert className="h-5 w-5 text-destructive" /> : <ScrollText className="h-5 w-5 text-muted-foreground" />}
                <div>
                  <div className="font-medium text-sm">
                    <span className="text-primary font-mono">{log.action}</span> on <span className="text-muted-foreground font-mono">{log.resourceType}</span>
                  </div>
                  <div className="text-sm text-foreground">{log.summary}</div>
                </div>
              </div>
              
              <div className="flex items-center gap-4 text-xs font-mono">
                <span className="text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</span>
                {log.riskTier && (
                   <span className={`px-2 py-1 rounded ${log.riskTier === 'L4' ? 'bg-destructive/20 text-destructive' : 'bg-muted'}`}>
                     {log.riskTier}
                   </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No audit events found.
          </div>
        )}
      </div>
    </div>
  );
}
