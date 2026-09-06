import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { DEMO } from "@/lib/demo-flag";
import {
  LOGIN_ACCESS_COOKIE,
  loginAccessCookieMaxAge,
  loginAccessDay,
  shouldRecordLoginAccess,
} from "@/lib/login-access";

const PROTECTED_PREFIXES = [
  "/home",
  "/chat",
  "/docs",
  "/admin",
  "/generate",
  "/news",
  "/notices",
  "/me",
  "/guide",
  "/change-password",
];

export async function middleware(request: NextRequest) {
  // 데모 모드: 인증/Supabase 없이 전체 경로 통과.
  // DEMO 는 실제 Supabase 백엔드가 연결된 배포에서는 강제로 꺼진다(lib/demo-flag.ts) —
  // 플래그 하나로 실데이터 환경의 인증이 통째로 열리는 사고를 막기 위함.
  if (DEMO) {
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
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
          headersToSet: Record<string, string>
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
          Object.entries(headersToSet).forEach(([name, value]) =>
            supabaseResponse.headers.set(name, value)
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

  // 로그인 화면 조회가 아니라 인증 후 보호 화면에 실제 진입했을 때만 집계한다.
  // Supabase session_id가 DB의 1차 중복 방지 수단이고, HttpOnly 일일 쿠키는 같은
  // 브라우저의 새로고침·재로그인에서 불필요한 RPC 호출까지 줄인다.
  const now = new Date();
  if (
    user &&
    isProtected &&
    shouldRecordLoginAccess(
      request.cookies.get(LOGIN_ACCESS_COOKIE)?.value,
      now
    )
  ) {
    try {
      const { error } = await supabase
        .rpc("record_daily_login_access")
        .abortSignal(AbortSignal.timeout(1_200));
      if (!error) {
        supabaseResponse.cookies.set(
          LOGIN_ACCESS_COOKIE,
          loginAccessDay(now),
          {
            httpOnly: true,
            sameSite: "lax",
            secure: request.nextUrl.protocol === "https:",
            path: "/",
            maxAge: loginAccessCookieMaxAge(now),
          }
        );
      }
    } catch {
      // 이용 통계 장애가 인증·서비스 접근을 막아서는 안 된다. 다음 요청에서 재시도한다.
    }
  }

  // 첫 로그인 비번 변경 강제는 getUserAndProfile(레이아웃이 이미 profile 조회)에서 처리한다.
  // 미들웨어에서 별도 profiles 조회를 하면 보호경로 클릭마다 Supabase 왕복이 추가돼 느려지므로 제거.

  return supabaseResponse;
}

export const config = {
  matcher: [
    // 정적 파일/이미지/콜백과 Workflow 내부 실행 경로를 제외한 모든 경로.
    // 내부 step POST를 인증 미들웨어가 가로채면 영속 작업의 재개·재시도가 끊긴다.
    "/((?!_next/static|_next/image|favicon.ico|auth/callback|\\.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
