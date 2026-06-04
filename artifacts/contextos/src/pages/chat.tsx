import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListConversations,
  getListConversationsQueryKey,
  useCreateConversation,
  useDeleteConversation,
  useListConversationMessages,
  getListConversationMessagesQueryKey,
  usePostConversationMessage,
  useGetRun,
  getGetRunQueryKey,
  useApproveApproval,
  useDenyApproval,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  MessageSquare,
  Plus,
  Send,
  Trash2,
  Activity,
  CheckSquare,
  Bot,
  User as UserIcon,
  Loader2,
} from "lucide-react";

type ChatRole = "user" | "agent" | "system";
type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  usedStub?: boolean | null;
  runId?: string | null;
  createdAt?: string;
  streaming?: boolean;
};

const TERMINAL = ["completed", "failed", "cancelled"];

function StubLiveBadge({ usedStub }: { usedStub: boolean }) {
  return (
    <span
      className={`text-[10px] font-mono px-2 rounded uppercase tracking-wide ${
        usedStub
          ? "bg-amber-500/10 text-amber-500 border border-amber-500/30"
          : "bg-green-500/10 text-green-500 border border-green-500/30"
      }`}
      title={
        usedStub
          ? "This reply came from the deterministic simulated stub (no live model endpoint was reached)."
          : "This reply came from a real configured model endpoint."
      }
    >
      {usedStub ? "Stub" : "Live"}
    </span>
  );
}

function RunCard({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { data: run } = useGetRun(runId, {
    query: {
      enabled: !!runId,
      queryKey: getGetRunQueryKey(runId),
      refetchInterval: (query: any) => {
        const status = query.state.data?.status;
        return status && TERMINAL.includes(status) ? false : 3000;
      },
    },
  });
  const approveMutation = useApproveApproval();
  const denyMutation = useDenyApproval();

  const pending = useMemo(
    () => (run?.approvals ?? []).filter((a: any) => a.status === "pending"),
    [run],
  );

  const decide = async (action: "approve" | "deny", id: string) => {
    try {
      if (action === "approve") await approveMutation.mutateAsync({ id });
      else await denyMutation.mutateAsync({ id });
      toast({ title: `Approval ${action === "approve" ? "approved" : "denied"}` });
      queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(runId) });
    } catch (e: any) {
      toast({ title: `Failed to ${action}`, description: e.message, variant: "destructive" });
    }
  };

  const status = run?.status ?? "pending";

  return (
    <div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono">
          <Activity className="h-4 w-4 text-primary" />
          <span className="font-medium">Run started</span>
          <span className="text-xs text-muted-foreground">{runId.slice(0, 8)}</span>
        </div>
        <span
          className={`text-xs font-mono px-2 py-0.5 rounded uppercase ${
            status === "completed"
              ? "bg-green-500/10 text-green-500"
              : status === "failed"
                ? "bg-destructive/10 text-destructive"
                : status === "waiting_approval"
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-blue-500/10 text-blue-500"
          }`}
        >
          {status.replace("_", " ")}
        </span>
      </div>

      {pending.length > 0 && (
        <div className="mt-3 space-y-2">
          {pending.map((a: any) => (
            <div key={a.id} className="rounded border border-amber-500/30 bg-amber-500/5 p-2">
              <div className="flex items-center gap-2 mb-1">
                <CheckSquare className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-medium">{a.actionName || "Action"}</span>
                <span className="text-[10px] font-mono px-1.5 rounded bg-muted uppercase">{a.riskTier}</span>
              </div>
              {a.reason && <div className="text-xs text-muted-foreground mb-2">{a.reason}</div>}
              <div className="flex gap-2">
                <button
                  onClick={() => decide("approve", a.id)}
                  disabled={approveMutation.isPending}
                  className="px-2.5 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Approve
                </button>
                <button
                  onClick={() => decide("deny", a.id)}
                  disabled={denyMutation.isPending}
                  className="px-2.5 py-1 rounded text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Link
        href={`/runs/${runId}`}
        className="mt-2 inline-block text-xs text-primary hover:underline font-mono"
      >
        View run details →
      </Link>
    </div>
  );
}

function upsert(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = [...list];
  next[idx] = { ...next[idx], ...msg };
  return next;
}

export function Chat() {
  const queryClient = useQueryClient();
  const { data: conversations, isLoading: loadingList } = useListConversations();
  const createMutation = useCreateConversation();
  const deleteMutation = useDeleteConversation();
  const postMutation = usePostConversationMessage();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: initialMessages, isLoading: loadingMessages } = useListConversationMessages(
    selectedId ?? "",
    { query: { enabled: !!selectedId, queryKey: getListConversationMessagesQueryKey(selectedId ?? "") } },
  );

  // Auto-select the most recent conversation on first load.
  useEffect(() => {
    if (!selectedId && conversations && conversations.length > 0) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations, selectedId]);

  // Seed local thread state from the persisted messages when the conversation
  // changes or its initial load resolves.
  useEffect(() => {
    if (initialMessages) {
      setMessages(initialMessages.map((m: any) => ({ ...m })));
    }
  }, [initialMessages, selectedId]);

  // Live stream: agent replies, run-driven updates, and message echoes.
  useEffect(() => {
    if (!selectedId) return;
    const es = new EventSource(`/api/conversations/${selectedId}/events`);
    es.onmessage = (ev) => {
      let payload: any;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (payload.kind) {
        case "message":
          setMessages((prev) => upsert(prev, payload.message));
          break;
        case "reply.start":
          setStreaming(true);
          setMessages((prev) =>
            upsert(prev, {
              id: payload.messageId,
              role: "agent",
              content: "",
              streaming: true,
            }),
          );
          break;
        case "reply.chunk":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === payload.messageId
                ? { ...m, content: m.content + payload.delta, streaming: true }
                : m,
            ),
          );
          break;
        case "reply.done":
          setStreaming(false);
          setMessages((prev) => upsert(prev, { ...payload.message, streaming: false }));
          queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
          break;
        case "reply.error":
          setStreaming(false);
          toast({ title: "Assistant error", description: payload.message, variant: "destructive" });
          break;
      }
    };
    es.onerror = () => {
      // Browser auto-reconnects; nothing to do.
    };
    return () => es.close();
  }, [selectedId, queryClient]);

  // Keep the thread scrolled to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleNewConversation = async () => {
    try {
      const conv = await createMutation.mutateAsync({ data: {} });
      queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      setSelectedId(conv.id);
      setMessages([]);
    } catch (e: any) {
      toast({ title: "Failed to start conversation", description: e.message, variant: "destructive" });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      if (selectedId === id) {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (e: any) {
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content) return;
    let convId = selectedId;
    try {
      if (!convId) {
        const conv = await createMutation.mutateAsync({ data: {} });
        convId = conv.id;
        setSelectedId(conv.id);
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      }
      setInput("");
      const userMsg = await postMutation.mutateAsync({ id: convId, data: { content } });
      setMessages((prev) => upsert(prev, userMsg as ChatMessage));
      queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    } catch (e: any) {
      toast({ title: "Failed to send", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-3rem)]">
      {/* Conversation list */}
      <aside className="w-72 flex flex-col border rounded-lg bg-card overflow-hidden">
        <div className="p-3 border-b flex items-center justify-between">
          <h2 className="text-sm font-bold font-mono flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" /> Chats
          </h2>
          <button
            onClick={handleNewConversation}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loadingList && <Skeleton className="w-full h-16" />}
          {conversations?.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer text-sm ${
                selectedId === c.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-muted/50"
              }`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{c.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {c.agentName ?? "Assistant"} · {c.messageCount} msg
                </div>
              </div>
              <button
                onClick={(e) => handleDelete(e, c.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {conversations?.length === 0 && !loadingList && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No conversations yet. Start one to chat with your agent.
            </div>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex-1 flex flex-col border rounded-lg bg-card overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <Bot className="h-10 w-10 opacity-40" />
            <div className="text-sm">Select a conversation or start a new one.</div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
              {loadingMessages && <Skeleton className="w-full h-24" />}
              {(() => {
                const seenRuns = new Set<string>();
                return messages.map((m) => {
                  let showRunCard = false;
                  if (m.runId && !seenRuns.has(m.runId)) {
                    seenRuns.add(m.runId);
                    showRunCard = true;
                  }
                  return (
                <div
                  key={m.id}
                  className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {m.role !== "user" && (
                    <div className="mt-1 h-7 w-7 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div className={`max-w-[75%] ${m.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
                    <div
                      className={`rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
                        m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : m.role === "system"
                            ? "bg-muted/60 text-muted-foreground italic"
                            : "bg-muted"
                      }`}
                    >
                      {m.content}
                      {m.streaming && <Loader2 className="inline-block ml-1 h-3 w-3 animate-spin" />}
                    </div>
                    {m.role === "agent" && (m.usedStub === true || m.usedStub === false) && (
                      <div className="mt-1 px-1">
                        <StubLiveBadge usedStub={m.usedStub} />
                      </div>
                    )}
                    {showRunCard && m.runId && <RunCard runId={m.runId} />}
                  </div>
                  {m.role === "user" && (
                    <div className="mt-1 h-7 w-7 shrink-0 rounded-full bg-muted flex items-center justify-center">
                      <UserIcon className="h-4 w-4" />
                    </div>
                  )}
                </div>
                  );
                });
              })()}
              {messages.length === 0 && !loadingMessages && (
                <div className="text-center text-sm text-muted-foreground py-12">
                  Send a message to start the conversation.
                </div>
              )}
            </div>

            <form onSubmit={handleSend} className="border-t p-3 flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message your agent…"
                className="flex-1 px-3 py-2 rounded-md border bg-background text-sm"
              />
              <button
                type="submit"
                disabled={postMutation.isPending || streaming || !input.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
