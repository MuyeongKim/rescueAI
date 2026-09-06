import { createHash } from "node:crypto";
import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo-flag";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { USER_GUIDE_VERSION } from "@/lib/user-guide-content";
import {
  createUserGuideMetadataPatch,
  createUserGuideSessionCookie,
  getUserGuidePreferences,
  getVerifiedGuideSessionId,
  hasUserGuideSessionCookie,
  isSameOriginUserGuideRequest,
  isUserGuidePreferenceSaved,
  unavailableUserGuidePreferences,
  userGuidePreferenceInputSchema,
} from "@/lib/user-guide-preferences";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

function failure(message: string, status = 503) {
  return Response.json({ ...unavailableUserGuidePreferences(), error: message }, { status, headers });
}

async function currentGuideUser(action: "read" | "write") {
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const limited = rateLimit(`user-guide:${action}:${auth.user.id}`, action === "read" ? 120 : 20, 60_000);
  if (!limited.ok) return { ok: false as const, response: tooManyRequests(limited.retryAfterSec) };

  // getClaims()는 설치된 Supabase SDK가 JWT 서명과 만료를 검증한다.
  // 요청 본문·쿠키의 user 객체·JWT user_metadata로 사용자나 표시 설정을 정하지 않는다.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) {
    return { ok: false as const, response: failure("로그인 상태를 확인하지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.") };
  }
  const sessionId = getVerifiedGuideSessionId(data.claims, auth.user.id);
  if (!sessionId) {
    return { ok: false as const, response: failure("현재 로그인 정보를 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.") };
  }
  const sessionHash = createHash("sha256").update(`user-guide:${auth.user.id}:${sessionId}`).digest("hex");
  return { ok: true as const, supabase, user: auth.user, metadata: auth.userMetadata, sessionHash };
}

export async function GET(request: Request) {
  // 실백엔드가 연결되면 DEMO는 demo-flag에서 자동으로 꺼진다.
  if (DEMO) return Response.json(unavailableUserGuidePreferences(), { headers });
  try {
    const current = await currentGuideUser("read");
    if (!current.ok) return current.response;
    const dismissedForSession = hasUserGuideSessionCookie(request, current.sessionHash);
    return Response.json(getUserGuidePreferences(current.metadata, dismissedForSession), { headers });
  } catch {
    return failure("사용설명서 표시 설정을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
}

export async function POST(request: Request) {
  if (!isSameOriginUserGuideRequest(request)) return failure("이 사이트에서 다시 시도해 주세요.", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return failure("JSON 형식의 요청이 필요합니다.", 415);
  }
  if (DEMO) return failure("데모에서는 계정별 안내 설정을 저장하지 않습니다.");

  try {
    const current = await currentGuideUser("write");
    if (!current.ok) return current.response;
    const parsed = userGuidePreferenceInputSchema.safeParse(await readLimitedJsonBody(request, 1024));
    if (!parsed.success) return failure("안내 표시 설정을 확인해 주세요.", 400);
    if (parsed.data.version !== USER_GUIDE_VERSION) {
      return failure("사용설명서가 업데이트되었습니다. 새로고침한 뒤 새 안내를 확인해 주세요.", 409);
    }

    const before = getUserGuidePreferences(current.metadata, false);
    const savedHeaders = { ...headers, "Set-Cookie": createUserGuideSessionCookie(request, current.sessionHash) };
    // 기본 닫기는 이 브라우저의 로그인 확인 쿠키만 설정한다. 다른 기기 기록을 쓰거나 덮지 않는다.
    // 필드 생략은 계정 선택을 유지한다. 명시적 선택은 다른 기기의 직전 선택과 관계없이 저장한다.
    if (parsed.data.hideForVersion === undefined) {
      return Response.json({ ...before, shouldShow: false }, { headers: savedHeaders });
    }
    const patch = createUserGuideMetadataPatch(parsed.data.hideForVersion);
    const { data, error } = await current.supabase.auth.updateUser({ data: patch });
    if (error || !data.user || data.user.id !== current.user.id) {
      return failure("안내 표시 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
    }
    if (!isUserGuidePreferenceSaved(data.user.user_metadata, parsed.data.hideForVersion)) {
      return failure("안내 표시 설정이 저장되었는지 확인하지 못했습니다. 다시 시도해 주세요.");
    }
    const saved = getUserGuidePreferences(data.user.user_metadata, true);
    return Response.json(saved, { headers: savedHeaders });
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) return failure(error.message, error.status);
    return failure("안내 표시 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  }
}
