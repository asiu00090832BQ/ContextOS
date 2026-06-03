import { useState } from "react";
import {
  useListApiKeys,
  getListApiKeysQueryKey,
  useCreateApiKey,
  useRevokeApiKey,
} from "@workspace/api-client-react";
import type { ApiKeyCreated } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, Plus, Trash2, Copy, Check, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

export function ApiKeys() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListApiKeys({
    query: { queryKey: getListApiKeysQueryKey() },
  });

  const createMutation = useCreateApiKey();
  const revokeMutation = useRevokeApiKey();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await createMutation.mutateAsync({
        data: {
          name: name.trim(),
          expiresInDays: expiresInDays.trim()
            ? Number(expiresInDays)
            : undefined,
        },
      });
      setCreated(result);
      setName("");
      setExpiresInDays("");
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to create key",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleRevoke = async (id: string) => {
    if (!confirm("Revoke this API key? Any client using it will lose access."))
      return;
    try {
      await revokeMutation.mutateAsync({ id });
      toast({ title: "API key revoked" });
      invalidate();
    } catch (error: any) {
      toast({
        title: "Failed to revoke key",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const closeDialog = () => {
    setIsCreateOpen(false);
    setCreated(null);
    setName("");
    setExpiresInDays("");
  };

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold font-mono">API Keys</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Mint keys so an external AI or script on another computer can
            authenticate to this workspace.
          </p>
        </div>
        <Dialog
          open={isCreateOpen}
          onOpenChange={(open) => (open ? setIsCreateOpen(true) : closeDialog())}
        >
          <DialogTrigger asChild>
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="w-4 h-4" /> Create Key
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>
                {created ? "Copy your API key" : "Create API Key"}
              </DialogTitle>
            </DialogHeader>

            {created ? (
              <div className="space-y-4 pt-4">
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    This is the only time the full key is shown. Store it
                    somewhere safe.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border bg-muted/40 p-3 text-xs font-mono">
                    {created.token}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border hover:bg-muted"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <button
                  onClick={closeDialog}
                  className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleCreate} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full p-2 rounded-md border bg-background"
                    placeholder="e.g. My laptop agent"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Expires in days{" "}
                    <span className="text-muted-foreground font-normal">
                      (optional — leave blank for no expiry)
                    </span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                    className="w-full p-2 rounded-md border bg-background"
                    placeholder="e.g. 90"
                  />
                </div>
                <button
                  disabled={createMutation.isPending}
                  type="submit"
                  className="w-full py-2 bg-primary text-primary-foreground rounded-md font-medium disabled:opacity-60"
                >
                  {createMutation.isPending ? "Creating..." : "Create Key"}
                </button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((key) => (
          <Card key={key.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-lg font-medium flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                {key.name}
              </CardTitle>
              <button
                onClick={() => handleRevoke(key.id)}
                className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                title="Revoke key"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </CardHeader>
            <CardContent className="pt-4 grid grid-cols-2 gap-y-2 text-sm">
              <div className="text-muted-foreground">Key</div>
              <div className="font-mono">
                {key.keyPrefix}…{key.lastFour}
              </div>
              <div className="text-muted-foreground">Last used</div>
              <div className="font-mono">
                {key.lastUsedAt
                  ? new Date(key.lastUsedAt).toLocaleString()
                  : "Never"}
              </div>
              <div className="text-muted-foreground">Expires</div>
              <div className="font-mono">
                {key.expiresAt
                  ? new Date(key.expiresAt).toLocaleDateString()
                  : "Never"}
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No API keys yet. Create one to let an external AI authenticate.
          </div>
        )}
      </div>
    </div>
  );
}
