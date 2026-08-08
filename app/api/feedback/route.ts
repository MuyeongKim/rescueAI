import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { DEMO } from "@/lib/demo";

// 답변 피드백 저장 (§8.2). RLS로 본인 메시지만 업데이트 가능.
export async function POST(req: Request) {
  if (DEMO) return Response.json({ ok: true });
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit(`feedback:${auth.user.id}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let body: { messageId?: number; feedback?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { messageId, feedback } = body;
  // feedback: 1=👍, -1=👎, 0=평가 취소(null 로 저장)
  if (typeof messageId !== "number" || (feedback !== 1 && feedback !== -1 && feedback !== 0)) {
    return new Response("messageId(number)와 feedback(1|-1|0)이 필요합니다.", {
      status: 400,
    });
  }

  const { error } = await supabase
    .from("messages")
    .update({ feedback: feedback === 0 ? null : feedback })
    .eq("id", messageId);

  if (error) {
    console.error("[feedback] 업데이트 실패:", error.message);
    return new Response("저장 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}
