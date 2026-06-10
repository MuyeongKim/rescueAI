import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, demoNotices } from "@/lib/demo";
import { NoticeManager } from "@/components/admin/NoticeManager";

export const dynamic = "force-dynamic";

async function loadNotices() {
  if (DEMO) return demoNotices;
  const supabase = await createClient();
  const { data } = await supabase
    .from("notices")
    .select("id, title, content, pinned, created_at")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  return data ?? [];
}

export default async function AdminNoticesPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const notices = await loadNotices();

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">공지 작성</h1>
        <p className="text-sm text-muted-foreground">
          전체 대원에게 표시되는 공지사항을 등록·관리합니다.
        </p>
      </div>
      <NoticeManager notices={notices} />
    </div>
  );
}
