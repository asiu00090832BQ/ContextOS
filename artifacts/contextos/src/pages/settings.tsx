import { useListTelemetryExports, getListTelemetryExportsQueryKey, useListDeploymentTargets, getListDeploymentTargetsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings as SettingsIcon, Send, Cloud } from "lucide-react";

export function Settings() {
  const { data: exports, isLoading: exportsLoading } = useListTelemetryExports({ query: { queryKey: getListTelemetryExportsQueryKey() } });
  const { data: targets, isLoading: targetsLoading } = useListDeploymentTargets({ query: { queryKey: getListDeploymentTargetsQueryKey() } });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Platform Settings</h1>
      </div>
      
      <section className="space-y-4">
        <h2 className="text-xl font-bold font-mono flex items-center gap-2">
          <Send className="w-5 h-5 text-primary" /> Telemetry Exports
        </h2>
        {exportsLoading ? <Skeleton className="w-full h-32" /> : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {exports?.map((exp) => (
              <Card key={exp.id} className="bg-card">
                <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                  <CardTitle className="text-md font-medium">{exp.name}</CardTitle>
                  <div className={`w-2 h-2 rounded-full ${exp.enabled ? 'bg-green-500' : 'bg-red-500'}`}></div>
                </CardHeader>
                <CardContent className="pt-4 flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Format</span>
                    <span className="font-mono uppercase">{exp.format}</span>
                  </div>
                  {exp.endpoint && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Endpoint</span>
                      <span className="font-mono truncate max-w-[200px]">{exp.endpoint}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {exports?.length === 0 && (
              <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
                No telemetry exports configured.
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-bold font-mono flex items-center gap-2">
          <Cloud className="w-5 h-5 text-primary" /> Deployment Targets
        </h2>
        {targetsLoading ? <Skeleton className="w-full h-32" /> : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {targets?.map((target) => (
              <Card key={target.id} className="bg-card">
                <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
                  <CardTitle className="text-md font-medium">{target.name}</CardTitle>
                  {target.isDefault && (
                    <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded font-mono uppercase">Default</span>
                  )}
                </CardHeader>
                <CardContent className="pt-4 flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type</span>
                    <span className="font-mono uppercase">{target.type}</span>
                  </div>
                  {target.region && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Region</span>
                      <span className="font-mono uppercase">{target.region}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {targets?.length === 0 && (
              <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
                No deployment targets configured.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
