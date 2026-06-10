// 공지사항 조회 헬퍼 (서버 전용).
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";

/** NEW 표시 기준: 최근 7일 이내 등록 */
export const NEW_NOTICE_DAYS = 7;

export function isNewNotice(createdAt: string): boolean {
  const since = Date.now() - NEW_NOTICE_DAYS * 86_400_000;
  return new Date(createdAt).getTime() >= since;
}

/** 최근 7일 이내 등록된 공지가 있는지 (사이드바 NEW 점 표시용) */
export async function hasRecentNotice(): Promise<boolean> {
  if (DEMO) return true; // 데모에서는 항상 NEW 표시(미리보기용)
  const supabase = await createClient();
  const since = new Date(Date.now() - NEW_NOTICE_DAYS * 86_400_000).toISOString();
  const { count } = await supabase
    .from("notices")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  return (count ?? 0) > 0;
}
