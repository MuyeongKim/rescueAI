import { describe, expect, it } from "vitest";
import { USER_GUIDE_VERSION } from "@/lib/user-guide-content";
import {
  createUserGuideMetadataPatch,
  createUserGuideSessionCookie,
  getUserGuidePreferences,
  getVerifiedGuideSessionId,
  hasUserGuideSessionCookie,
  isSameOriginUserGuideRequest,
  isUserGuidePreferenceSaved,
  USER_GUIDE_METADATA_KEY,
  USER_GUIDE_SESSION_COOKIE,
  userGuidePreferenceInputSchema,
} from "@/lib/user-guide-preferences";

const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);
const endpoint = "https://rescue.example/api/user-guide";
const readRequest = (cookie?: string) => new Request(endpoint, { headers: cookie ? { Cookie: cookie } : {} });
const storedCookie = (hash = firstHash, version = USER_GUIDE_VERSION) => createUserGuideSessionCookie(readRequest(), hash, version).split(";", 1)[0];

describe("계정별 사용설명서 표시 계약", () => {
  it("설정이 없거나 손상됐으면 새 안내를 보여준다", () => {
    for (const metadata of [undefined, null, [], "invalid", {}, { [USER_GUIDE_METADATA_KEY]: { version: USER_GUIDE_VERSION, hideForVersion: "true" } }]) {
      expect(getUserGuidePreferences(metadata, false)).toEqual({ version: USER_GUIDE_VERSION, shouldShow: true, hideForVersion: false, available: true });
    }
  });

  it("서버가 발급한 현재 로그인 쿠키가 있을 때만 기본 닫기를 유지한다", () => {
    const request = readRequest(storedCookie());
    expect(hasUserGuideSessionCookie(request, firstHash)).toBe(true);
    expect(hasUserGuideSessionCookie(request, secondHash)).toBe(false);
    expect(getUserGuidePreferences({}, hasUserGuideSessionCookie(request, firstHash)).shouldShow).toBe(false);
    expect(getUserGuidePreferences({}, hasUserGuideSessionCookie(request, secondHash)).shouldShow).toBe(true);
  });

  it("쿠키와 계정 설정이 이전 안내 버전이면 다시 보여준다", () => {
    const metadata = createUserGuideMetadataPatch(true, "old-version");
    const request = readRequest(storedCookie(firstHash, "old-version"));
    expect(hasUserGuideSessionCookie(request, firstHash)).toBe(false);
    expect(getUserGuidePreferences(metadata, false)).toMatchObject({ shouldShow: true, hideForVersion: false });
  });

  it("다시 보지 않기는 쿠키 없는 새 로그인에도 적용하고 해제하면 다시 보여준다", () => {
    expect(getUserGuidePreferences(createUserGuideMetadataPatch(true), false)).toMatchObject({ shouldShow: false, hideForVersion: true });
    expect(getUserGuidePreferences(createUserGuideMetadataPatch(false), false)).toMatchObject({ shouldShow: true, hideForVersion: false });
    expect(getUserGuidePreferences(createUserGuideMetadataPatch(false), true).shouldShow).toBe(false);
  });

  it("계정 metadata 패치에는 버전·숨김만 있으며 다른 키나 로그인 해시를 포함하지 않는다", () => {
    const metadata = { full_name: "테스트 사용자", theme: "dark", role: "user" };
    const patch = createUserGuideMetadataPatch(true);
    expect(patch).toEqual({ [USER_GUIDE_METADATA_KEY]: { version: USER_GUIDE_VERSION, hideForVersion: true } });
    expect({ ...metadata, ...patch }).toMatchObject(metadata);
    expect(JSON.stringify(patch)).not.toContain(firstHash);
  });

  it("저장 확인에서는 필드 누락을 false 저장 성공으로 해석하지 않는다", () => {
    expect(isUserGuidePreferenceSaved({}, false)).toBe(false);
    expect(isUserGuidePreferenceSaved(createUserGuideMetadataPatch(false), false)).toBe(true);
    expect(isUserGuidePreferenceSaved(createUserGuideMetadataPatch(true), false)).toBe(false);
    expect(isUserGuidePreferenceSaved(createUserGuideMetadataPatch(false, "old-version"), false)).toBe(false);
  });

  it("쿠키는 host-only HttpOnly SameSite=Lax 세션이며 HTTPS에서 Secure를 사용한다", () => {
    const cookie = createUserGuideSessionCookie(readRequest(), firstHash);
    expect(cookie).toContain("Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(cookie).not.toMatch(/Domain=|Expires=|Max-Age=/i);
    expect(createUserGuideSessionCookie(new Request("http://localhost:3000/api/user-guide"), firstHash)).not.toContain("Secure");
  });

  it("손상·중복·접두사만 일치하는 쿠키는 무시하며 다른 쿠키가 함께 있어도 정확히 찾는다", () => {
    expect(hasUserGuideSessionCookie(readRequest(`other=1; ${storedCookie()}; unrelated=2`), firstHash)).toBe(true);
    for (const cookie of [undefined, `${USER_GUIDE_SESSION_COOKIE}=%E0%A4%A`, `${USER_GUIDE_SESSION_COOKIE}=${"x".repeat(300)}`, `${storedCookie()}; ${storedCookie()}`, `other_${storedCookie()}`, `${USER_GUIDE_SESSION_COOKIE}=not-a-session`]) {
      expect(hasUserGuideSessionCookie(readRequest(cookie), firstHash)).toBe(false);
    }
  });

  it("계정 설정 변경 없는 기본 닫기를 허용하고 사용자·세션 지정이나 문자열 boolean은 거부한다", () => {
    expect(userGuidePreferenceInputSchema.safeParse({ version: USER_GUIDE_VERSION }).success).toBe(true);
    expect(userGuidePreferenceInputSchema.safeParse({ version: USER_GUIDE_VERSION, hideForVersion: false }).success).toBe(true);
    expect(userGuidePreferenceInputSchema.safeParse({ version: USER_GUIDE_VERSION, hideForVersion: false, userId: "other" }).success).toBe(false);
    expect(userGuidePreferenceInputSchema.safeParse({ version: USER_GUIDE_VERSION, sessionId: "other" }).success).toBe(false);
    expect(userGuidePreferenceInputSchema.safeParse({ version: USER_GUIDE_VERSION, hideForVersion: "false" }).success).toBe(false);
  });

  it("가드가 인증한 계정과 일치하는 검증된 UUID 세션만 사용한다", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(getVerifiedGuideSessionId({ sub: "user-1", session_id: sessionId }, "user-1")).toBe(sessionId);
    expect(getVerifiedGuideSessionId({ sub: "other", session_id: sessionId }, "user-1")).toBeNull();
    expect(getVerifiedGuideSessionId({ sub: "user-1", session_id: "unverified" }, "user-1")).toBeNull();
    expect(getVerifiedGuideSessionId({ sub: "user-1" }, "user-1")).toBeNull();
  });

  it("같은 출처의 요청만 허용하고 누락·외부·서브도메인·null Origin을 거부한다", () => {
    const request = (origin?: string, site?: string) => new Request(endpoint, {
      method: "POST", headers: { ...(origin ? { Origin: origin } : {}), ...(site ? { "Sec-Fetch-Site": site } : {}) },
    });
    expect(isSameOriginUserGuideRequest(request("https://rescue.example", "same-origin"))).toBe(true);
    for (const req of [request(), request("null"), request("https://other.example"), request("https://sub.rescue.example"), request("https://rescue.example", "same-site"), request("https://rescue.example/path"), request("https://rescue.example", "cross-site")]) {
      expect(isSameOriginUserGuideRequest(req)).toBe(false);
    }
  });
});
