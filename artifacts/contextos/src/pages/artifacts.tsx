import { useListArtifacts, getListArtifactsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Download } from "lucide-react";

export function Artifacts() {
  const { data, isLoading } = useListArtifacts();

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Run Artifacts</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((artifact) => (
          <Card key={artifact.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium truncate" title={artifact.name}>{artifact.name}</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-primary/10 text-primary px-2 py-1 rounded font-mono">{artifact.type}</span>
                <span className="bg-muted px-2 py-1 rounded font-mono">{artifact.contentType}</span>
              </div>
              <div className="flex justify-between items-center mt-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                 <span>{(artifact.sizeBytes || 0) / 1024} KB</span>
                 <button className="text-primary hover:text-primary/80 flex items-center gap-1">
                   <Download className="w-3 h-3" /> Download
                 </button>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No artifacts generated yet.
          </div>
        )}
      </div>
    </div>
  );
}
