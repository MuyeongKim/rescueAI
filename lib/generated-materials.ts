// 저장한 생성물 조회 — /generate(최근), /generate/saved(전체), /me(개수)의 단일 출처.
// 서버 전용. RLS 로 본인 행만 반환된다.
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import type { SavedMaterial } from "@/lib/generate";

const COLS =
  "id, kind, category, audience, duration, topic, title, content, shared, author_name, created_at";

export async function listMyMaterials(limit = 100): Promise<SavedMaterial[]> {
  if (DEMO) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("generated_materials")
    .select(COLS)
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
  const { count } = await supabase
    .from("generated_materials")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}
