import { redirect } from "next/navigation";

import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { listAllNews } from "@/lib/news";
import { NewsManager } from "@/components/admin/NewsManager";
import { NewsRefreshButton } from "@/components/admin/NewsRefreshButton";

export const dynamic = "force-dynamic";

export default async function AdminNewsPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const items = await listAllNews();

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">동향 관리</h1>
          <p className="text-sm text-muted-foreground">
            구조 동향을 직접 등록하거나(AI 요약 보조), 자동 수집을 실행해 검수합니다.
          </p>
        </div>
        <NewsRefreshButton />
      </div>
      <NewsManager items={items} />
    </div>
  );
}
