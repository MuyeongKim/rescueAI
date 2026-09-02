import { describe, expect, it } from "vitest";

import {
  LOGIN_ACCESS_COOKIE,
  LOGIN_ACCESS_TRACKING_STARTED_ON,
  loginAccessCookieMaxAge,
  loginAccessDay,
  loginAccessTrackingStartLabel,
  shouldRecordLoginAccess,
} from "@/lib/login-access";

describe("로그인 접속 일일 중복 방지", () => {
  const beforeKstMidnight = new Date("2026-09-02T14:59:59Z");
  const afterKstMidnight = new Date("2026-09-02T15:00:00Z");

  it("브라우저 저장소가 아닌 전용 서버 쿠키 이름을 사용한다", () => {
    expect(LOGIN_ACCESS_COOKIE).toBe("rescueai-access-day");
  });

  it("운영 집계 시작일을 모호하지 않은 한국식 날짜로 제공한다", () => {
    expect(LOGIN_ACCESS_TRACKING_STARTED_ON).toBe("2026-09-02");
    expect(loginAccessTrackingStartLabel()).toBe("2026. 9. 2.");
  });

  it("같은 KST 날짜의 재요청은 기록하지 않는다", () => {
    expect(loginAccessDay(beforeKstMidnight)).toBe("2026-09-02");
    expect(
      shouldRecordLoginAccess("2026-09-02", beforeKstMidnight)
    ).toBe(false);
  });

  it("쿠키가 없거나 KST 날짜가 바뀌면 다시 기록한다", () => {
    expect(shouldRecordLoginAccess(undefined, beforeKstMidnight)).toBe(true);
    expect(loginAccessDay(afterKstMidnight)).toBe("2026-09-03");
    expect(shouldRecordLoginAccess("2026-09-02", afterKstMidnight)).toBe(
      true
    );
  });

  it("쿠키는 다음 KST 자정까지만 유지한다", () => {
    expect(loginAccessCookieMaxAge(beforeKstMidnight)).toBe(1);
    expect(loginAccessCookieMaxAge(afterKstMidnight)).toBe(24 * 60 * 60);
  });
});
