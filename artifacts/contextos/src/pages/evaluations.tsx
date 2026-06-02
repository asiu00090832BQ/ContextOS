import { useListEvaluationRecords, getListEvaluationRecordsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, HelpCircle } from "lucide-react";

export function Evaluations() {
  const { data, isLoading } = useListEvaluationRecords({ query: { queryKey: getListEvaluationRecordsQueryKey() } });

  if (isLoading) {
    return <Skeleton className="w-full h-64" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold font-mono">Evaluations</h1>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.map((evalRecord) => (
          <Card key={evalRecord.id} className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/50">
              <CardTitle className="text-md font-medium truncate">{evalRecord.name}</CardTitle>
              {evalRecord.label === 'success' ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : 
               evalRecord.label === 'failure' ? <XCircle className="h-4 w-4 text-destructive" /> : 
               <HelpCircle className="h-4 w-4 text-muted-foreground" />}
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-muted px-2 py-1 rounded font-mono uppercase">{evalRecord.evaluatorType}</span>
                {evalRecord.isReferenceExample && (
                  <span className="bg-primary/20 text-primary px-2 py-1 rounded font-mono uppercase">Reference</span>
                )}
              </div>
              <div className="text-sm text-foreground">
                <span className="font-semibold text-muted-foreground">Score: </span>
                <span className="font-mono">{evalRecord.score ?? 'N/A'}</span>
              </div>
              {evalRecord.reviewNote && (
                <div className="text-sm text-muted-foreground italic border-l-2 border-primary/50 pl-2">
                  "{evalRecord.reviewNote}"
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <div className="col-span-full p-8 text-center text-muted-foreground bg-muted/20 border border-dashed rounded-lg">
            No evaluations found.
          </div>
        )}
      </div>
    </div>
  );
}
