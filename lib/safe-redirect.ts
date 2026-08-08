// 로그인 후 이동 경로(redirect 쿼리) 검증 — 순수 함수, 클라이언트/서버 공용.
//
// 왜 필요한가: `?redirect=` 값을 그대로 window.location.assign()/NextResponse.redirect() 에 넘기면
//   - `https://evil.example`  → 로그인 직후 외부 사이트로 튕겨 피싱에 쓰인다(오픈 리다이렉트).
//   - `javascript:...`        → 로그인된 오리진에서 스크립트가 실행된다(XSS).
// 따라서 "우리 앱 안의 절대 경로"만 통과시키고, 나머지는 전부 기본값으로 되돌린다.

export const DEFAULT_REDIRECT = "/home";

// 제어문자·공백 제거 — 스킴 위장("java\nscript:", " javascript:")을 먼저 무력화한다.
// 정상 URL 이면 공백은 %20 으로 인코딩돼 오므로 지워도 경로가 깨지지 않는다.
function stripControlAndSpace(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * 앱 내부 경로일 때만 그대로 돌려주고, 아니면 fallback(기본 "/home")을 준다.
 * 허용: "/home", "/chat/abc?x=1#y"
 * 차단: "https://evil.example", "//evil.example", "/\evil.example", "javascript:...", "/login"(루프)
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT
): string {
  if (typeof value !== "string") return fallback;

  const raw = stripControlAndSpace(value);
  if (!raw) return fallback;

  // 반드시 "/" 하나로 시작해야 한다. "//host"·"/\host" 는 프로토콜 상대 URL 로 해석돼 외부로 나간다.
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;

  // 백슬래시는 일부 브라우저가 "/" 로 정규화하므로 경로에 남기지 않는다.
  if (raw.includes("\\")) return fallback;

  // 로그인 페이지로 되돌리면 무한 루프가 된다.
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) {
    return fallback;
  }

  return raw;
}
