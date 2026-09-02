import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LoginAccessStats,
  SidebarAccessStats,
} from "@/components/auth/LoginAccessStats";

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
const SIDEBAR = readFileSync(
  resolve(process.cwd(), "components/layout/AppSidebar.tsx"),
  "utf8"
);
const STATS_SERVER = readFileSync(
  resolve(process.cwd(), "lib/login-access-stats.ts"),
  "utf8"
);
const GLOBALS = readFileSync(
  resolve(process.cwd(), "app/globals.css"),
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
    expect(html).toContain("2026. 9. 2. 시작");
    expect(html).toContain("실제 이용 인원과 다를 수");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("py-2.5");
    expect(html).not.toContain("aria-live");
  });

  it("로그인 후 사이드바 하단에도 같은 오늘·누적 수치를 표시한다", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarAccessStats, { today: 3, total: 17 })
    );

    expect(html).toContain("접속 현황");
    expect(html).toContain("오늘");
    expect(html).toContain("누적");
    expect(html).toContain("3");
    expect(html).toContain("17");
    expect(html).toContain("2026. 9. 2. 시작");
    expect(html).toContain("KST 기준 로그인 세션 접속 횟수");
    expect(SIDEBAR).toContain("<SidebarAccessStats");
    expect(SIDEBAR).toContain("Promise.all([");
    expect(GLOBALS).toContain(".sidebar-access-stats-date");
    expect(GLOBALS).toContain(".sidebar-theme-toggle");
  });

  it("사이드바 통계를 불러오지 못하면 보조기기에 상태를 설명한다", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarAccessStats, { today: null, total: null })
    );

    expect(html).toContain("집계 정보를 불러오지 못했습니다");
    expect(html).toContain("aria-describedby=\"sidebar-access-stats-note\"");
  });

  it("정적 페이지는 Server Component이고 로그인 폼만 Client leaf로 둔다", () => {
    expect(PAGE.startsWith('"use client"')).toBe(false);
    expect(PAGE).toContain('from "@/lib/login-access-stats"');
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
    expect(STATS_SERVER).toContain('.rpc("get_login_access_stats")');
    expect(STATS_SERVER).toContain("AbortSignal.timeout(1_200)");
    expect(STATS_SERVER).toContain("통계 장애가 로그인이나 서비스 화면 렌더링을 막아서는 안 된다");
  });
});
