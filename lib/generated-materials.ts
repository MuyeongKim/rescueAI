// 저장한 생성물 조회 — /generate(최근), /generate/saved(전체), /me(개수)의 단일 출처.
// 서버 전용. 개인 자료 조회는 RLS에 더해 인증 user_id를 명시해 방어적으로 제한한다.
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import type { SavedMaterial } from "@/lib/generate";

const COLS =
  "id, kind, category, audience, duration, topic, title, content, revision, shared, author_name, created_at";

export async function listMyMaterials(limit = 100): Promise<SavedMaterial[]> {
  if (DEMO) return [];
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("generated_materials")
    .select(COLS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as SavedMaterial[];
}

// 공유된 자료(동료가 만든 것 포함) — RLS "shared materials read" 로 shared=true 행만 조회.
export async function listSharedMaterials(limit = 100): Promise<SavedMaterial[]> {
  if (DEMO) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("generated_materials")
    .select(COLS)
    .eq("shared", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as SavedMaterial[];
}

export async function countMyMaterials(): Promise<number> {
  if (DEMO) return 0;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 0;

  const { count } = await supabase
    .from("generated_materials")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  return count ?? 0;
}
