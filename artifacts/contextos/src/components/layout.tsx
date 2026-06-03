import React from "react";
import { Link, useLocation } from "wouter";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { LayoutDashboard, Cable, Zap, ListTree, Activity, Database, KeyRound, Network, Cpu, Microscope, Settings, BrainCircuit } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/model-endpoints", label: "Model Endpoints", icon: BrainCircuit },
  { href: "/linked-accounts", label: "Accounts", icon: KeyRound },
  { href: "/adapters", label: "Adapters", icon: Cable },
  { href: "/capabilities", label: "Capabilities", icon: Zap },
  { href: "/intents", label: "Intents", icon: ListTree },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/artifacts", label: "Artifacts", icon: Database },
  { href: "/agents", label: "Agents", icon: Cpu },
  { href: "/integrations", label: "Integrations", icon: Network },
  { href: "/observability", label: "Traces", icon: Microscope },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });

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
        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent/50'}`}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
