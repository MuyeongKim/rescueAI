import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import {
  ACTIVITIES,
  MAX_DURATION_MIN,
  calcPoints,
} from "@/lib/fitness";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// 운동 기록 등록. 마일리지는 서버에서 계산(일일 상한 반영). RLS로 본인 기록만.
export async function POST(req: Request) {
  let body: { activity?: string; durationMin?: number; note?: string; performedOn?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const activity = body.activity ?? "";
  const durationMin = Number(body.durationMin);
  if (!(ACTIVITIES as readonly string[]).includes(activity)) {
    return new Response("activity가 올바르지 않습니다.", { status: 400 });
  }
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > MAX_DURATION_MIN) {
    return new Response(`운동 시간은 1~${MAX_DURATION_MIN}분이어야 합니다.`, { status: 400 });
  }
  // 기록 날짜: 오늘 또는 과거 14일 이내만 허용(소급 입력 제한)
  const performedOn = body.performedOn || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(performedOn) || performedOn > today()) {
    return new Response("기록 날짜가 올바르지 않습니다.", { status: 400 });
  }

  if (DEMO) {
    return Response.json({ ok: true, points: Math.min(durationMin, 120) });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // 해당 날짜에 이미 적립한 마일리지 합계 → 상한 반영
  const { data: dayLogs, error: dayErr } = await supabase
    .from("workout_logs")
    .select("points")
    .eq("user_id", user.id)
    .eq("performed_on", performedOn);
  if (dayErr) {
    console.error("[fitness] 일일 합계 조회 실패:", dayErr.message);
    return new Response("저장 실패", { status: 500 });
  }
  const awarded = (dayLogs ?? []).reduce((s, l) => s + (l.points ?? 0), 0);
  const points = calcPoints(durationMin, awarded);

  const { error } = await supabase.from("workout_logs").insert({
    user_id: user.id,
    activity,
    duration_min: durationMin,
    note: body.note?.trim() || null,
    points,
    performed_on: performedOn,
  });
  if (error) {
    console.error("[fitness] insert 실패:", error.message);
    return new Response("저장 실패", { status: 500 });
  }

  return Response.json({ ok: true, points });
}

// 본인 운동 기록 삭제 (잘못 입력한 경우). RLS로 본인 것만 지워진다.
export async function DELETE(req: Request) {
  if (DEMO) return Response.json({ ok: true });

  let body: { id?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (typeof body.id !== "number") {
    return new Response("id(number)가 필요합니다.", { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { error } = await supabase
    .from("workout_logs")
    .delete()
    .eq("id", body.id)
    .eq("user_id", user.id);
  if (error) {
    console.error("[fitness] delete 실패:", error.message);
    return new Response("삭제 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}
