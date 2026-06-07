import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Mail,
  Link2,
  Link2Off,
  BrainCircuit,
  Plug,
  ShieldCheck,
  Trash2,
  Plus,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

interface AllowedSender {
  id: string;
  address: string;
}
interface EmailStatus {
  connected: boolean;
  error?: string;
  inbox: { inboxId: string; email: string } | null;
  webhook: { configured: boolean };
  enabled: boolean;
  allowedSenders: AllowedSender[];
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function apiSend<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export function Email() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["email", "status"],
    queryFn: () => apiGet<EmailStatus>("/email/status"),
  });
  const modelQuery = useQuery({
    queryKey: ["email", "model"],
    queryFn: () => apiGet<{ modelEndpointName: string }>("/email/model"),
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [newSender, setNewSender] = useState("");

  const status = statusQuery.data;
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/email/webhook`
      : "";
  const connected = Boolean(status?.webhook?.configured);

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: ["email", "status"] });

  const handleSetWebhook = async () => {
    setBusy("set");
    try {
      const res = await apiSend<{ inbox?: { email?: string } }>(
        "/email/set-webhook",
        "POST",
        { url: webhookUrl },
      );
      toast({
        title: "Email channel connected",
        description: res.inbox?.email
          ? `Inbox: ${res.inbox.email}`
          : webhookUrl,
      });
      await refreshStatus();
    } catch (err) {
      toast({
        title: "Could not connect",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteWebhook = async () => {
    setBusy("delete");
    try {
      await apiSend("/email/delete-webhook", "POST");
      toast({ title: "Email channel disconnected" });
      await refreshStatus();
    } catch (err) {
      toast({
        title: "Could not disconnect",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleAddSender = async () => {
    const address = newSender.trim();
    if (!address) return;
    setBusy("add-sender");
    try {
      await apiSend("/email/allowed-senders", "POST", { address });
      setNewSender("");
      toast({ title: "Sender allowed", description: address });
      await refreshStatus();
    } catch (err) {
      toast({
        title: "Could not add sender",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveSender = async (sender: AllowedSender) => {
    setBusy(`remove-${sender.id}`);
    try {
      await apiSend(`/email/allowed-senders/${sender.id}`, "DELETE");
      await refreshStatus();
    } catch (err) {
      toast({
        title: "Could not remove sender",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
          <Mail className="w-6 h-6 text-primary" /> Email Bot
        </h1>
      </div>

      {statusQuery.isLoading ? (
        <Skeleton className="w-full h-40" />
      ) : !status?.connected ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-md font-medium flex items-center gap-2">
              <Plug className="w-5 h-5 text-amber-500" /> AgentMail not connected
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The AgentMail integration is not authorized for this workspace yet.
            Connect AgentMail, then reload this page to provision the bot's inbox
            and wire up two-way email.
            {status?.error && (
              <div className="mt-2 text-destructive font-mono text-xs">
                {status.error}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-4">
          <h2 className="text-xl font-bold font-mono flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" /> Connection
          </h2>
          <Card className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium flex items-center gap-2 font-mono">
                {status.inbox?.email ?? "Inbox not provisioned"}
              </CardTitle>
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Connected" : "Not connected"}
              </Badge>
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Webhook URL</span>
                <span
                  className="font-mono truncate max-w-[60%]"
                  title={webhookUrl}
                >
                  {webhookUrl}
                </span>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={handleSetWebhook} disabled={busy !== null}>
                  <Link2 className="w-4 h-4 mr-1" />
                  {connected ? "Reconnect" : "Connect"} email
                </Button>
                {connected && (
                  <Button
                    variant="outline"
                    onClick={handleDeleteWebhook}
                    disabled={busy !== null}
                  >
                    <Link2Off className="w-4 h-4 mr-1" /> Disconnect
                  </Button>
                )}
              </div>
              {!connected && (
                <p className="text-xs text-muted-foreground">
                  Connecting provisions the bot's inbox (if needed) and registers
                  the inbound webhook so the bot can receive and reply to email.
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {status?.connected && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold font-mono flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" /> Allowed senders
          </h2>
          <Card className="bg-card">
            <CardContent className="pt-6 flex flex-col gap-4 text-sm">
              <p className="text-muted-foreground">
                Only emails from these addresses are processed by the bot. Mail
                from anyone else is silently ignored.
              </p>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="person@example.com"
                  value={newSender}
                  onChange={(e) => setNewSender(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddSender();
                  }}
                />
                <Button
                  onClick={handleAddSender}
                  disabled={busy !== null || !newSender.trim()}
                >
                  <Plus className="w-4 h-4 mr-1" /> Add
                </Button>
              </div>
              {status.allowedSenders.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No senders allowed yet — add at least one address so the bot can
                  respond to your email.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/50">
                  {status.allowedSenders.map((sender) => (
                    <li
                      key={sender.id}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="font-mono">{sender.address}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveSender(sender)}
                        disabled={busy !== null}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-xl font-bold font-mono flex items-center gap-2">
          <BrainCircuit className="w-5 h-5 text-primary" /> Model
        </h2>
        <Card className="bg-card">
          <CardContent className="pt-6 flex flex-col gap-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Current model</span>
              <span className="font-mono">
                {modelQuery.isLoading
                  ? "…"
                  : (modelQuery.data?.modelEndpointName ?? "—")}
              </span>
            </div>
            <p className="text-muted-foreground">
              The email bot IS the ContextOS Bot agent — it uses that agent's
              model, tools, and memory, so it behaves identically to the in-app
              chat and Telegram. To change the model, set it on the{" "}
              <Link
                href="/agents"
                className="text-primary underline underline-offset-2"
              >
                ContextOS Bot agent
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
