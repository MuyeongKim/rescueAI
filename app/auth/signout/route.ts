import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// 로그아웃: 현재 브라우저 세션만 제거하고 /login 으로 보낸다.
// 같은 계정을 여러 기기에서 쓰더라도 한 사람의 로그아웃이 다른 세션까지 끊지 않는다.
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
