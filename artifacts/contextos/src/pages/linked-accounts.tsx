import { useState } from "react";
import { useListLinkedAccounts, getListLinkedAccountsQueryKey, useCreateLinkedAccount, useDeleteLinkedAccount, useRefreshLinkedAccount, useRevokeLinkedAccount } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, Plus, RefreshCw, Ban, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function LinkedAccounts() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListLinkedAccounts({ query: { queryKey: getListLinkedAccountsQueryKey() } });
  
  const createMutation = useCreateLinkedAccount();
  const deleteMutation = useDeleteLinkedAccount();
  const refreshMutation = useRefreshLinkedAccount();
  const revokeMutation = useRevokeLinkedAccount();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formData, setFormData] = useState({ systemName: "", displayName: "", authMode: "oauth2" });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({ data: formData });
      toast({ title: "Account linked successfully" });
      setIsCreateOpen(false);
      setFormData({ systemName: "", displayName: "", authMode: "oauth2" });
      queryClient.invalidateQueries({ queryKey: getListLinkedAccountsQueryKey() });
    } catch (error: any) {
      toast({ title: "Failed to link account", description: error.message, variant: "destructive" });
    }
  };

  const handleAction = async (action: 'refresh' | 'revoke' | 'delete', id: string) => {
    try {
      if (action === 'refresh') await refreshMutation.mutateAsync({ id });
      if (action === 'revoke') await revokeMutation.mutateAsync({ id });
      if (action === 'delete') await deleteMutation.mutateAsync({ id });
      toast({ title: `Account ${action}d successfully` });
      queryClient.invalidateQueries({ queryKey: getListLinkedAccountsQueryKey() });
    } catch (error: any) {
      toast({ title: `Failed to ${action} account`, description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Linked Accounts</h1>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Link Account
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Link New Account</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">System Name</label>
                <input required value={formData.systemName} onChange={e => setFormData({...formData, systemName: e.target.value})} className="w-full p-2 rounded-md border bg-background" placeholder="e.g. github" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Display Name</label>
                <input required value={formData.displayName} onChange={e => setFormData({...formData, displayName: e.target.value})} className="w-full p-2 rounded-md border bg-background" placeholder="e.g. My GitHub" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Auth Mode</label>
                <select value={formData.authMode} onChange={e => setFormData({...formData, authMode: e.target.value})} className="w-full p-2 rounded-md border bg-background">
                  <option value="oauth2">OAuth2</option>
                  <option value="apiKey">API Key</option>
                  <option value="basic">Basic Auth</option>
                </select>
              </div>
              <button disabled={createMutation.isPending} type="submit" className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium">
                {createMutation.isPending ? "Linking..." : "Link Account"}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((account) => (
          <Card key={account.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium">{account.displayName}</CardTitle>
              <KeyRound className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="pt-4">
              <div className="text-sm text-muted-foreground mb-2">System: {account.systemName}</div>
              <div className="flex justify-between items-center">
                <div className={`text-xs font-mono px-2 py-1 rounded inline-block ${account.status === 'active' ? 'bg-green-500/20 text-green-500' : 'bg-muted'}`}>
                  {account.status}
                </div>
                <div className="flex gap-2">
                   <button onClick={() => handleAction('refresh', account.id)} className="p-1.5 text-muted-foreground hover:text-primary transition-colors" title="Refresh">
                     <RefreshCw className="w-4 h-4" />
                   </button>
                   <button onClick={() => handleAction('revoke', account.id)} className="p-1.5 text-muted-foreground hover:text-orange-500 transition-colors" title="Revoke">
                     <Ban className="w-4 h-4" />
                   </button>
                   <button onClick={() => handleAction('delete', account.id)} className="p-1.5 text-muted-foreground hover:text-destructive transition-colors" title="Delete">
                     <Trash2 className="w-4 h-4" />
                   </button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No linked accounts found.
          </div>
        )}
      </div>
    </div>
  );
}
