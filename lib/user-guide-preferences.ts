import { z } from "zod";
import { USER_GUIDE_VERSION } from "@/lib/user-guide-content";

/** 사용자 편의 설정일 뿐이며 인증·역할·자료 접근 권한에 사용하면 안 된다. */
export const USER_GUIDE_METADATA_KEY = "rescue_user_guide";
export const USER_GUIDE_SESSION_COOKIE = "rescue_user_guide_seen";

export type UserGuidePreferences = {
  version: string;
  shouldShow: boolean;
  hideForVersion: boolean;
  available: boolean;
};

export const userGuidePreferenceInputSchema = z.object({
  version: z.string().min(1).max(80),
  hideForVersion: z.boolean().optional(),
}).strict();

type StoredPreferences = {
  version: string;
  hideForVersion: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStoredPreferences(metadata: unknown, version: string): StoredPreferences {
  const stored = record(record(metadata)?.[USER_GUIDE_METADATA_KEY]);
  if (stored?.version !== version || typeof stored.hideForVersion !== "boolean") {
    return { version, hideForVersion: false };
  }
  return { version, hideForVersion: stored.hideForVersion };
}

/** 최신 getUser() 결과에서만 읽는다. JWT에 복사된 user_metadata는 오래될 수 있다. */
export function getUserGuidePreferences(
  metadata: unknown,
  dismissedForSession: boolean,
  version: string = USER_GUIDE_VERSION,
): UserGuidePreferences {
  const stored = readStoredPreferences(metadata, version);
  return {
    version,
    shouldShow: !stored.hideForVersion && !dismissedForSession,
    hideForVersion: stored.hideForVersion,
    available: true,
  };
}

/**
 * updateUser({ data: patch })에 전달할 이 기능의 키만 만든다.
 * Supabase가 상위 메타데이터 키를 병합하므로 이름 등 다른 설정을 오래된 값으로 덮지 않는다.
 * 로그인별 확인 기록은 이곳에 쓰지 않아 다른 기기에서 닫아도 기록이 덮이지 않는다.
 */
export function createUserGuideMetadataPatch(
  hideForVersion: boolean,
  version: string = USER_GUIDE_VERSION,
): Record<string, StoredPreferences> {
  return { [USER_GUIDE_METADATA_KEY]: { version, hideForVersion } };
}

/** 기본값 해석이 아닌 Auth 서버가 실제 돌려준 저장 필드를 확인한다. */
export function isUserGuidePreferenceSaved(metadata: unknown, hideForVersion: boolean, version: string = USER_GUIDE_VERSION): boolean {
  const stored = record(record(metadata)?.[USER_GUIDE_METADATA_KEY]);
  return stored?.version === version && stored.hideForVersion === hideForVersion;
}

function sessionCookieValue(sessionHash: string, version: string): string {
  if (!/^[a-f0-9]{64}$/.test(sessionHash)) throw new Error("Invalid guide session hash");
  return `${version}:${sessionHash}`;
}

/**
 * 서버가 설정하는 안내용 HttpOnly 세션 쿠키. 권한 판단이나 인증 증명으로 사용하지 않는다.
 * Domain·Expires·Max-Age를 생략해 현재 호스트·브라우저 세션에만 적용한다.
 */
export function createUserGuideSessionCookie(request: Request, sessionHash: string, version: string = USER_GUIDE_VERSION): string {
  const value = encodeURIComponent(sessionCookieValue(sessionHash, version));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${USER_GUIDE_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** 쿠키의 사용자 식별자를 신뢰하지 않고 검증된 현재 로그인 해시와 정확히 대조한다. */
export function hasUserGuideSessionCookie(request: Request, sessionHash: string, version: string = USER_GUIDE_VERSION): boolean {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;
  const matches = cookieHeader.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${USER_GUIDE_SESSION_COOKIE}=`));
  if (matches.length !== 1) return false;
  const value = matches[0].slice(USER_GUIDE_SESSION_COOKIE.length + 1);
  if (value.length > 256) return false;
  try {
    return decodeURIComponent(value) === sessionCookieValue(sessionHash, version);
  } catch {
    return false;
  }
}

/** 호출 전 getClaims()로 서명·만료를 검증하고 공통 가드가 확인한 계정과 대조한다. */
export function getVerifiedGuideSessionId(claims: unknown, authenticatedUserId: string): string | null {
  const value = record(claims);
  if (value?.sub !== authenticatedUserId) return null;
  const parsed = z.string().uuid().safeParse(value.session_id);
  return parsed.success ? parsed.data : null;
}

/** 쿠키 인증 POST는 같은 출처의 JSON 요청만 허용한다. 전달받은 host 헤더는 신뢰하지 않는다. */
export function isSameOriginUserGuideRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    const expected = new URL(request.url);
    const actual = new URL(origin);
    return (actual.protocol === "https:" || actual.protocol === "http:")
      && actual.origin === expected.origin && actual.href === `${actual.origin}/`;
  } catch {
    return false;
  }
}

export function unavailableUserGuidePreferences(): UserGuidePreferences {
  return { version: USER_GUIDE_VERSION, shouldShow: false, hideForVersion: false, available: false };
}
