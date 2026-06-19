import { Skeleton } from "@/components/ui/skeleton";

export default function ChatLoading() {
  return (
    <div className="flex h-full flex-col">
      {/* 상단 바 */}
      <div className="border-b bg-background/80 px-3 py-2 sm:px-4">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Skeleton className="h-10 w-24 rounded-md" />
          <Skeleton className="h-10 w-28 rounded-md" />
          <Skeleton className="h-10 w-36 rounded-md" />
        </div>
      </div>
      {/* 본문 */}
      <div className="flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl space-y-4 px-3 py-6 sm:px-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="ml-auto h-16 w-2/3 rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
