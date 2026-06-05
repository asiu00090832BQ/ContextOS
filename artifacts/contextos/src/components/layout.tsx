import React from "react";
import { Link, useLocation } from "wouter";
import {
  useGetMe,
  getGetMeQueryKey,
  useGetDashboard,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { toast } from "@/hooks/use-toast";
import {
  LayoutDashboard,
  Cable,
  ListTree,
  Activity,
  Database,
  KeyRound,
  Cpu,
  Microscope,
  Settings,
  BrainCircuit,
  Brain,
  Bot,
  CheckSquare,
  ScrollText,
  Gauge,
  Radio,
  MessageSquare,
  Send,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ElementType };
type NavGroup = { title: string | null; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    title: null,
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    title: "Agents & Models",
    items: [
      { href: "/agents", label: "Agents", icon: Cpu },
      { href: "/model-endpoints", label: "Model Endpoints", icon: BrainCircuit },
    ],
  },
  {
    title: "Tools & Connections",
    items: [
      { href: "/servers", label: "MCP Servers", icon: Cable },
      { href: "/linked-accounts", label: "Accounts", icon: KeyRound },
    ],
  },
  {
    title: "Work",
    items: [
      { href: "/chat", label: "Chat", icon: MessageSquare },
      { href: "/telegram", label: "Telegram", icon: Send },
      { href: "/intents", label: "Intents", icon: ListTree },
      { href: "/runs", label: "Runs", icon: Activity },
      { href: "/approvals", label: "Approvals", icon: CheckSquare },
    ],
  },
  {
    title: "Context & Data",
    items: [
      { href: "/artifacts", label: "Artifacts", icon: Database },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/bot", label: "Bot", icon: Bot },
    ],
  },
  {
    title: "Observability",
    items: [
      { href: "/observability", label: "Traces", icon: Microscope },
      { href: "/evaluations", label: "Evaluations", icon: Gauge },
      { href: "/audit", label: "Audit Log", icon: ScrollText },
    ],
  },
  {
    title: "Remote & Access",
    items: [
      { href: "/remote-access", label: "Remote Access", icon: Radio },
      { href: "/api-keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    title: "System",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

function isItemActive(location: string, href: string): boolean {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const { data: dashboard } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: 20000,
      refetchIntervalInBackground: true,
    },
  });
  const newBotServerCount = dashboard?.newBotServerCount ?? 0;

  const prevCountRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const prev = prevCountRef.current;
    if (prev !== null && newBotServerCount > prev) {
      const added = newBotServerCount - prev;
      toast({
        title:
          added === 1
            ? "The assistant built a new web service"
            : `The assistant built ${added} new web services`,
        description: "Open MCP Servers to review them.",
      });
    }
    prevCountRef.current = newBotServerCount;
  }, [newBotServerCount]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="w-64 flex flex-col border-r bg-sidebar">
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold tracking-tight text-primary">ContextOS</h1>
          {me && (
            <div className="mt-2 flex flex-col">
              <span className="text-xs text-muted-foreground">{me.tenant.name}</span>
              <span className="text-xs text-muted-foreground">{me.user.email}</span>
            </div>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-4">
          {navGroups.map((group, gi) => (
            <div key={group.title ?? `group-${gi}`} className="space-y-1">
              {group.title && (
                <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.title}
                </div>
              )}
              {group.items.map((item) => {
                const isActive = isItemActive(location, item.href);
                const badgeCount =
                  item.href === "/servers" ? newBotServerCount : 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                    }`}
                  >
                    <item.icon className="w-4 h-4" />
                    <span className="flex-1">{item.label}</span>
                    {badgeCount > 0 && (
                      <span
                        className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
                        title={`${badgeCount} new bot-built ${
                          badgeCount === 1 ? "web service" : "web services"
                        } to review`}
                        aria-label={`${badgeCount} new bot-built web services to review`}
                      >
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6">{children}</div>
      </main>
    </div>
  );
}
