import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginAccessStats } from "@/components/auth/LoginAccessStats";

const PAGE = readFileSync(
  resolve(process.cwd(), "app/(auth)/login/page.tsx"),
  "utf8"
);
const FORM = readFileSync(
  resolve(process.cwd(), "app/(auth)/login/login-form.tsx"),
  "utf8"
);
const MIDDLEWARE = readFileSync(
  resolve(process.cwd(), "middleware.ts"),
  "utf8"
);

describe("로그인 접속 현황 UI", () => {
  it("사람 수가 아닌 KST 접속 횟수와 집계 한계를 설명한다", () => {
    const html = renderToStaticMarkup(
      createElement(LoginAccessStats, { today: 6, total: 42 })
    );

    expect(html).toContain("오늘 접속");
    expect(html).toContain("시범운영 누적");
    expect(html).toContain("6");
    expect(html).toContain("42");
    expect(html).toContain("실제 인원수와 다를 수 있습니다");
    expect(html).toContain("tabular-nums");
    expect(html).not.toContain("aria-live");
  });

  it("정적 페이지는 Server Component이고 로그인 폼만 Client leaf로 둔다", () => {
    expect(PAGE.startsWith('"use client"')).toBe(false);
    expect(PAGE).toContain('from "@/lib/supabase/server"');
    expect(FORM.startsWith('"use client"')).toBe(true);
    expect(FORM).toContain('from "@/lib/supabase/client"');
  });

  it("모바일 터치·긴 이메일·짧은 화면을 보완한다", () => {
    expect(FORM).toContain("absolute inset-y-0 right-0 flex w-12");
    expect(FORM).toContain("[overflow-wrap:anywhere]");
    expect(PAGE).toContain("min-h-[152px]");
    expect(PAGE).toContain("login-panel");
  });

  it("접속 통계 실패는 시간 제한 후 인증 흐름을 막지 않는다", () => {
    expect(MIDDLEWARE).toContain(
      '.rpc("record_daily_login_access")'
    );
    expect(MIDDLEWARE).toContain("AbortSignal.timeout(1_200)");
    expect(MIDDLEWARE).toContain("이용 통계 장애가 인증·서비스 접근을 막아서는 안 된다");
    expect(MIDDLEWARE).toContain("httpOnly: true");
    expect(MIDDLEWARE).toContain('sameSite: "lax"');
  });
});
