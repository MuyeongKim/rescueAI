import { Skeleton } from "@/components/ui/skeleton";

export default function GenerateLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full max-w-md" />
      <div className="space-y-3 rounded-lg border p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-md" />
        ))}
        <Skeleton className="h-11 w-32 rounded-md" />
      </div>
    </div>
  );
}
