import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const PROTECTED_PREFIXES = [
  "/home",
  "/chat",
  "/docs",
  "/admin",
  "/generate",
  "/news",
  "/dispatch",
  "/fitness",
  "/notices",
  "/me",
  "/change-password",
];

export async function middleware(request: NextRequest) {
  // 데모 모드: 인증/Supabase 없이 전체 경로 통과
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 중요: getUser() 호출로 세션을 갱신한다. 이 줄과 createServerClient 사이에 로직을 넣지 말 것.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/")
  );

  // 미인증 사용자가 보호 경로 접근 → /login (AC-1)
  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  // 인증 사용자가 /login 접근 → /home
  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/home";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 첫 로그인 비번 변경 강제는 getUserAndProfile(레이아웃이 이미 profile 조회)에서 처리한다.
  // 미들웨어에서 별도 profiles 조회를 하면 보호경로 클릭마다 Supabase 왕복이 추가돼 느려지므로 제거.

  return supabaseResponse;
}

export const config = {
  matcher: [
    // 정적 파일/이미지/콜백을 제외한 모든 경로
    "/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
