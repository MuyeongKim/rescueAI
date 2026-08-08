import { describe, it, expect } from "vitest";
import { safeRedirectPath, DEFAULT_REDIRECT } from "@/lib/safe-redirect";

// 로그인 후 이동 경로는 공격자가 링크로 심을 수 있는 값이다.
// 앱 내부 경로만 통과해야 한다(오픈 리다이렉트·javascript: 실행 차단).
describe("safeRedirectPath", () => {
  it("앱 내부 절대 경로는 그대로 통과시킨다", () => {
    expect(safeRedirectPath("/home")).toBe("/home");
    expect(safeRedirectPath("/chat/abc-123")).toBe("/chat/abc-123");
    expect(safeRedirectPath("/docs/7?page=3#top")).toBe("/docs/7?page=3#top");
  });

  it("외부 절대 URL 을 차단한다", () => {
    expect(safeRedirectPath("https://evil.example")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("http://evil.example/path")).toBe(DEFAULT_REDIRECT);
  });

  it("프로토콜 상대 URL(//host, /\\host)을 차단한다", () => {
    expect(safeRedirectPath("//evil.example")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("/\\evil.example")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("/\\/evil.example")).toBe(DEFAULT_REDIRECT);
  });

  it("javascript:/data: 스킴을 차단한다 (공백·개행 위장 포함)", () => {
    expect(safeRedirectPath("javascript:alert(1)")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("  javascript:alert(1)")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("java\nscript:alert(1)")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("\tjavascript:alert(1)")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("data:text/html,<script>x</script>")).toBe(DEFAULT_REDIRECT);
  });

  it("상대 경로·빈 값·비문자열은 기본값으로 돌린다", () => {
    expect(safeRedirectPath("home")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_REDIRECT);
  });

  it("/login 으로 되돌리지 않는다 (리다이렉트 루프 방지)", () => {
    expect(safeRedirectPath("/login")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("/login?redirect=/home")).toBe(DEFAULT_REDIRECT);
  });

  it("fallback 을 지정할 수 있다", () => {
    expect(safeRedirectPath("https://evil.example", "/chat")).toBe("/chat");
  });
});
