import { useState } from "react";
import { useListApprovals, getListApprovalsQueryKey, useApproveApproval, useDenyApproval } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function Approvals() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListApprovals();
  
  const approveMutation = useApproveApproval();
  const denyMutation = useDenyApproval();

  const [notes, setNotes] = useState<Record<string, string>>({});

  const handleApprove = async (id: string) => {
    try {
      await approveMutation.mutateAsync({ id, data: { note: notes[id] } });
      toast({ title: "Action approved" });
      queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
    } catch (e: any) {
      toast({ title: "Failed to approve", description: e.message, variant: "destructive" });
    }
  };

  const handleDeny = async (id: string) => {
    try {
      await denyMutation.mutateAsync({ id, data: { note: notes[id] } });
      toast({ title: "Action denied" });
      queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
    } catch (e: any) {
      toast({ title: "Failed to deny", description: e.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Pending Approvals</h1>
      </div>
      
      <div className="grid grid-cols-1 gap-4">
        {data?.map((approval) => (
          <Card key={approval.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Action: {approval.actionName}
              </CardTitle>
              <div className="flex gap-2">
                <span className="text-xs font-mono px-2 py-1 rounded bg-destructive/20 text-destructive">
                  {approval.riskTier}
                </span>
                <span className={`text-xs font-mono px-2 py-1 rounded uppercase ${
                  approval.status === 'pending' ? 'bg-orange-500/20 text-orange-500' :
                  approval.status === 'approved' ? 'bg-green-500/20 text-green-500' : 'bg-muted'
                }`}>
                  {approval.status}
                </span>
              </div>
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="text-sm text-foreground">
                <span className="font-semibold text-muted-foreground">Reason: </span>
                {approval.reason || 'No reason provided.'}
              </div>
              
              {approval.status === 'pending' && (
                <div className="flex flex-col gap-2 mt-2">
                  <input 
                    type="text" 
                    placeholder="Optional note for decision..."
                    value={notes[approval.id] || ''}
                    onChange={(e) => setNotes({...notes, [approval.id]: e.target.value})}
                    className="w-full p-2 text-sm rounded-md border bg-background"
                  />
                  <div className="flex gap-2">
                    <button 
                      onClick={() => handleApprove(approval.id)}
                      disabled={approveMutation.isPending || denyMutation.isPending}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button 
                      onClick={() => handleDeny(approval.id)}
                      disabled={approveMutation.isPending || denyMutation.isPending}
                      className="px-4 py-2 bg-destructive/10 text-destructive border border-destructive/20 rounded text-sm font-medium hover:bg-destructive/20 transition-colors disabled:opacity-50"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No pending approvals.
          </div>
        )}
      </div>
    </div>
  );
}
