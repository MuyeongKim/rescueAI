import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// 로그아웃: 세션을 제거하고 /login 으로 보낸다.
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
