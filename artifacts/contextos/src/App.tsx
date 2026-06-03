import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/pages/dashboard";
import { LinkedAccounts } from "@/pages/linked-accounts";
import { Adapters } from "@/pages/adapters";
import { AdapterDetail } from "@/pages/adapter-detail";
import { Capabilities } from "@/pages/capabilities";
import { Intents } from "@/pages/intents";
import { IntentDetail } from "@/pages/intent-detail";
import { Runs } from "@/pages/runs";
import { RunDetail } from "@/pages/run-detail";
import { Approvals } from "@/pages/approvals";
import { Artifacts } from "@/pages/artifacts";
import { Memory } from "@/pages/memory";
import { Audit } from "@/pages/audit";
import { Agents } from "@/pages/agents";
import { AgentDetail } from "@/pages/agent-detail";
import { ModelEndpoints } from "@/pages/model-endpoints";
import { ApiKeys } from "@/pages/api-keys";
import { RemoteAccess } from "@/pages/remote-access";
import { Integrations } from "@/pages/integrations";
import { BlueprintDetail } from "@/pages/blueprint-detail";
import { GeneratedServerDetail } from "@/pages/generated-server-detail";
import { Observability } from "@/pages/observability";
import { TraceDetail } from "@/pages/trace-detail";
import { Evaluations } from "@/pages/evaluations";
import { Settings } from "@/pages/settings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/linked-accounts" component={LinkedAccounts} />
        <Route path="/adapters" component={Adapters} />
        <Route path="/adapters/:id" component={AdapterDetail} />
        <Route path="/capabilities" component={Capabilities} />
        <Route path="/intents" component={Intents} />
        <Route path="/intents/:id" component={IntentDetail} />
        <Route path="/runs" component={Runs} />
        <Route path="/runs/:id" component={RunDetail} />
        <Route path="/approvals" component={Approvals} />
        <Route path="/artifacts" component={Artifacts} />
        <Route path="/memory" component={Memory} />
        <Route path="/audit" component={Audit} />
        <Route path="/agents" component={Agents} />
        <Route path="/agents/:id" component={AgentDetail} />
        <Route path="/model-endpoints" component={ModelEndpoints} />
        <Route path="/api-keys" component={ApiKeys} />
        <Route path="/remote-access" component={RemoteAccess} />
        <Route path="/integrations" component={Integrations} />
        <Route path="/integrations/blueprints/:id" component={BlueprintDetail} />
        <Route path="/integrations/servers/:id" component={GeneratedServerDetail} />
        <Route path="/observability" component={Observability} />
        <Route path="/observability/traces/:id" component={TraceDetail} />
        <Route path="/evaluations" component={Evaluations} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
