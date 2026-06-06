import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Send, Link2, Link2Off, BrainCircuit, Bot } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

interface TelegramBot {
  id: number;
  username?: string;
  first_name?: string;
}
interface TelegramWebhook {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
}
interface TelegramStatus {
  tokenConfigured: boolean;
  secretConfigured: boolean;
  bot: TelegramBot | null;
  webhook: TelegramWebhook | null;
  error?: string;
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
  method: "POST" | "PUT",
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

export function Telegram() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["telegram", "status"],
    queryFn: () => apiGet<TelegramStatus>("/telegram/status"),
  });
  const modelQuery = useQuery({
    queryKey: ["telegram", "model"],
    queryFn: () => apiGet<{ modelEndpointName: string }>("/telegram/model"),
  });

  const [busy, setBusy] = useState<string | null>(null);

  const status = statusQuery.data;
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/telegram/webhook`
      : "";
  const connected = Boolean(status?.webhook?.url);

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: ["telegram", "status"] });

  const handleSetWebhook = async () => {
    setBusy("set");
    try {
      await apiSend("/telegram/set-webhook", "POST", { url: webhookUrl });
      toast({ title: "Webhook connected", description: webhookUrl });
      await refreshStatus();
    } catch (err) {
      toast({
        title: "Could not connect webhook",
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
      await apiSend("/telegram/delete-webhook", "POST");
      toast({ title: "Webhook disconnected" });
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

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono flex items-center gap-2">
          <Send className="w-6 h-6 text-primary" /> Telegram Bot
        </h1>
      </div>

      {statusQuery.isLoading ? (
        <Skeleton className="w-full h-40" />
      ) : !status?.tokenConfigured ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-md font-medium flex items-center gap-2">
              <Bot className="w-5 h-5 text-amber-500" /> Bot token required
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            A <span className="font-mono">TELEGRAM_BOT_TOKEN</span> secret has not
            been configured yet. Add it to this workspace (get one from
            @BotFather), then reload this page to connect the webhook.
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-4">
          <h2 className="text-xl font-bold font-mono flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" /> Connection
          </h2>
          <Card className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium flex items-center gap-2">
                {status.bot?.username
                  ? `@${status.bot.username}`
                  : (status.bot?.first_name ?? "Bot")}
              </CardTitle>
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Connected" : "Not connected"}
              </Badge>
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Webhook URL</span>
                <span className="font-mono truncate max-w-[60%]" title={webhookUrl}>
                  {connected ? status.webhook?.url : webhookUrl}
                </span>
              </div>
              {connected && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Pending updates</span>
                  <span className="font-mono">
                    {status.webhook?.pending_update_count ?? 0}
                  </span>
                </div>
              )}
              {status.webhook?.last_error_message && (
                <div className="flex justify-between gap-4 text-destructive">
                  <span>Last error</span>
                  <span className="font-mono truncate max-w-[60%]">
                    {status.webhook.last_error_message}
                  </span>
                </div>
              )}
              {status.error && (
                <div className="text-destructive">{status.error}</div>
              )}
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={handleSetWebhook}
                  disabled={busy !== null || !status.secretConfigured}
                >
                  <Link2 className="w-4 h-4 mr-1" />
                  {connected ? "Reconnect" : "Connect"} webhook
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
              {!status.secretConfigured && (
                <p className="text-xs text-muted-foreground">
                  Webhook secret not configured — the bot cannot verify incoming
                  updates.
                </p>
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
              The Telegram bot IS the ContextOS Bot agent — it uses that agent's
              model, tools, and memory, so it behaves identically to the in-app
              chat. To change the model, set it on the{" "}
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
