import { redirect } from "next/navigation";
import { Newspaper } from "lucide-react";

import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { listAllNews } from "@/lib/news";
import { NewsManager } from "@/components/admin/NewsManager";
import { NewsRefreshButton } from "@/components/admin/NewsRefreshButton";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

export default async function AdminNewsPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const items = await listAllNews();

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <OperationalHeader
        eyebrow="관리 업무 · 구조 동향"
        title="동향 관리"
        description="구조 동향을 직접 등록하거나 자동 수집을 실행해 검수합니다."
        icon={Newspaper}
        status={`${items.length}건 관리`}
      />
      <div className="flex justify-end">
        <NewsRefreshButton />
      </div>
      <NewsManager items={items} />
    </div>
  );
}
