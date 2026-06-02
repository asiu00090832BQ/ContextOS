import { useListMemory, getListMemoryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BrainCircuit } from "lucide-react";

export function Memory() {
  const { data, isLoading } = useListMemory();

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Agent Memory</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((mem) => (
          <Card key={mem.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium truncate" title={mem.key}>{mem.key}</CardTitle>
              <BrainCircuit className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-primary/10 text-primary px-2 py-1 rounded uppercase font-mono">{mem.type}</span>
                <span className="bg-muted px-2 py-1 rounded uppercase font-mono">{mem.sensitivity}</span>
              </div>
              <div className="text-sm text-foreground line-clamp-3 font-mono bg-muted/30 p-2 rounded">
                {mem.value}
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No memory entries found.
          </div>
        )}
      </div>
    </div>
  );
}
