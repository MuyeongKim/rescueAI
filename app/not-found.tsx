import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <SearchX className="h-7 w-7 text-muted-foreground" />
      </span>
      <div>
        <h1 className="text-lg font-semibold">페이지를 찾을 수 없습니다</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          주소가 바뀌었거나 삭제된 페이지일 수 있습니다.
        </p>
      </div>
      <Button asChild className="h-11">
        <Link href="/home">홈으로 돌아가기</Link>
      </Button>
    </div>
  );
}
