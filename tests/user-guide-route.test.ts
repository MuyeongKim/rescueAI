import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), requireApiUser: vi.fn(), rateLimit: vi.fn(), demo: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit, tooManyRequests: (delay: number) => new Response(null, { status: 429, headers: { "Retry-After": String(delay) } }) }));
vi.mock("@/lib/demo-flag", () => ({ get DEMO() { return mocks.demo; } }));

import { GET, POST } from "@/app/api/user-guide/route";
import { USER_GUIDE_VERSION } from "@/lib/user-guide-content";
import { createUserGuideMetadataPatch, USER_GUIDE_METADATA_KEY, USER_GUIDE_SESSION_COOKIE } from "@/lib/user-guide-preferences";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = "https://rescue.example/api/user-guide";
function readRequest(cookie?: string) { return new Request(endpoint, { headers: cookie ? { Cookie: cookie } : {} }); }
function responseCookie(response: Response) { return response.headers.get("set-cookie")!.split(";", 1)[0]; }

function client(initialMetadata: Record<string, unknown> = {}, activeSessionId = sessionId) {
  let metadata = structuredClone(initialMetadata);
  const db = {
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: userId, session_id: activeSessionId, user_metadata: { stale: true } } }, error: null })),
      updateUser: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        metadata = { ...metadata, ...data };
        return { data: { user: { id: userId, user_metadata: metadata } }, error: null };
      }),
    },
    metadata: () => metadata,
  };
  mocks.requireApiUser.mockImplementation(async (supabase: { metadata: () => Record<string, unknown> }) => ({ ok: true, user: { id: userId }, userMetadata: structuredClone(supabase.metadata()) }));
  mocks.createClient.mockResolvedValue(db);
  return db;
}

function request(body: unknown = { version: USER_GUIDE_VERSION }, headers: Record<string, string> = {}) {
  return new Request("https://rescue.example/api/user-guide", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://rescue.example", ...headers }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.demo = false;
  mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
});

describe("사용설명서 표시 설정 API", () => {
  it("설정 없는 계정은 안내를 보여주며 민감한 사용자·세션·metadata를 응답하지 않는다", async () => {
    const db = client({ full_name: "확인 사용자" });
    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: USER_GUIDE_VERSION, shouldShow: true, hideForVersion: false, available: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireApiUser).toHaveBeenCalledWith(db);
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it.each([401, 403])("인증·초기 비밀번호 가드의 %i 응답을 그대로 유지하고 Auth 설정에 접근하지 않는다", async (status) => {
    const db = client();
    mocks.requireApiUser.mockResolvedValue({ ok: false, response: new Response("blocked", { status }) });
    expect((await GET(readRequest())).status).toBe(status);
    expect((await POST(request())).status).toBe(status);
    expect(db.auth.getClaims).not.toHaveBeenCalled();
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("기본 닫기는 Auth 쓰기 없이 HttpOnly 쿠키로 유지되고 새 로그인에서는 다시 표시한다", async () => {
    const db = client({ full_name: "원래 이름", theme: "dark" });
    const saved = await POST(request());
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ shouldShow: false, hideForVersion: false, available: true });
    const cookie = responseCookie(saved);
    expect(cookie).toContain(`${USER_GUIDE_SESSION_COOKIE}=`);
    expect(saved.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Secure");
    expect(cookie).not.toContain(sessionId);
    expect(await (await GET(readRequest(cookie))).json()).toMatchObject({ shouldShow: false });
    expect(db.metadata()).toMatchObject({ full_name: "원래 이름", theme: "dark" });
    expect(db.auth.updateUser).not.toHaveBeenCalled();
    db.auth.getClaims.mockResolvedValue({ data: { claims: { sub: userId, session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", user_metadata: { stale: true } } }, error: null });
    expect(await (await GET(readRequest(cookie))).json()).toMatchObject({ shouldShow: true });
  });

  it("서명된 JWT 안의 오래된 메타데이터 대신 공통 가드의 최신 사용자 메타데이터를 사용한다", async () => {
    client(createUserGuideMetadataPatch(true));
    expect(await (await GET(readRequest())).json()).toMatchObject({ shouldShow: false, hideForVersion: true });
  });

  it("다시 보지 않기를 저장하면 새 로그인에서도 숨긴다", async () => {
    const db = client({ full_name: "원래 이름", theme: "dark" });
    expect((await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: true }))).status).toBe(200);
    expect(db.auth.updateUser).toHaveBeenCalledWith({ data: { [USER_GUIDE_METADATA_KEY]: { version: USER_GUIDE_VERSION, hideForVersion: true } } });
    expect(db.metadata()).toMatchObject({ full_name: "원래 이름", theme: "dark" });
    db.auth.getClaims.mockResolvedValue({ data: { claims: { sub: userId, session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", user_metadata: { stale: true } } }, error: null });
    expect(await (await GET(readRequest())).json()).toMatchObject({ shouldShow: false, hideForVersion: true });
  });

  it("기본 닫기 중복 요청은 동일 쿠키만 돌려주고 Auth 쓰기를 하지 않는다", async () => {
    const db = client();
    const first = await POST(request());
    const second = await POST(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(responseCookie(first)).toBe(responseCookie(second));
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("명시적인 숨김 선택은 같은 값이어도 사용자의 마지막 선택으로 저장한다", async () => {
    const db = client();
    expect((await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: true }))).status).toBe(200);
    expect((await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: true }))).status).toBe(200);
    expect(db.auth.updateUser).toHaveBeenCalledTimes(2);
  });

  it("두 로그인을 동시에 닫아도 서로 기록을 덮지 않고 각 쿠키가 독립 유지된다", async () => {
    const firstDb = client();
    const secondDb = client({}, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    mocks.createClient.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);
    const [first, second] = await Promise.all([POST(request()), POST(request())]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCookie = responseCookie(first);
    const secondCookie = responseCookie(second);
    expect(firstCookie).not.toBe(secondCookie);
    mocks.createClient.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);
    const [firstRead, secondRead] = await Promise.all([GET(readRequest(firstCookie)), GET(readRequest(secondCookie))]);
    expect(await firstRead.json()).toMatchObject({ shouldShow: false });
    expect(await secondRead.json()).toMatchObject({ shouldShow: false });
    expect(firstDb.auth.updateUser).not.toHaveBeenCalled();
    expect(secondDb.auth.updateUser).not.toHaveBeenCalled();
    mocks.createClient.mockResolvedValue(firstDb);
    expect(await (await GET(readRequest(secondCookie))).json()).toMatchObject({ shouldShow: true });
  });

  it("숨김 설정을 바꾸지 않은 오래된 팝업의 기본 닫기는 다른 기기의 계정 선택을 유지한다", async () => {
    const db = client();
    mocks.requireApiUser.mockImplementationOnce(async () => {
      const oldMetadata = structuredClone(db.metadata());
      await db.auth.updateUser({ data: createUserGuideMetadataPatch(true) });
      return { ok: true, user: { id: userId }, userMetadata: oldMetadata };
    });
    expect((await POST(request())).status).toBe(200);
    expect(db.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(db.metadata()).toMatchObject(createUserGuideMetadataPatch(true));
    expect(await (await GET(readRequest())).json()).toMatchObject({ hideForVersion: true, shouldShow: false });
  });

  it("명시적으로 숨김을 해제하면 계정 false를 저장하되 현재 로그인 확인은 유지한다", async () => {
    const db = client(createUserGuideMetadataPatch(true));
    const response = await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: false }));
    expect(response.status).toBe(200);
    expect(db.auth.updateUser).toHaveBeenCalledWith({ data: createUserGuideMetadataPatch(false) });
    expect(await (await GET(readRequest(responseCookie(response)))).json()).toMatchObject({ shouldShow: false, hideForVersion: false });
    expect(await (await GET(readRequest())).json()).toMatchObject({ shouldShow: true, hideForVersion: false });
  });

  it("초기 조회 뒤 다른 기기가 숨김을 바꿔도 명시적인 마지막 해제 선택을 저장한다", async () => {
    const db = client(createUserGuideMetadataPatch(false));
    mocks.requireApiUser.mockImplementationOnce(async () => {
      const oldMetadata = structuredClone(db.metadata());
      await db.auth.updateUser({ data: createUserGuideMetadataPatch(true) });
      return { ok: true, user: { id: userId }, userMetadata: oldMetadata };
    });
    const response = await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: false }));
    expect(response.status).toBe(200);
    expect(db.auth.updateUser).toHaveBeenCalledTimes(2);
    expect(db.metadata()).toMatchObject(createUserGuideMetadataPatch(false));
  });

  it("이전 안내 버전으로 저장하려 하면 409를 반환하고 기존 설정을 덮지 않는다", async () => {
    const db = client();
    const response = await POST(request({ version: "2026-01-01.1", hideForVersion: true }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ version: USER_GUIDE_VERSION, available: false });
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    { version: USER_GUIDE_VERSION, hideForVersion: true, userId: "victim" },
    { version: USER_GUIDE_VERSION, hideForVersion: false, sessionId },
    { version: USER_GUIDE_VERSION, hideForVersion: "true" },
    { hideForVersion: false },
  ])("잘못된 입력이나 다른 계정·세션 지정은 거부한다: %j", async (body) => {
    const db = client();
    expect((await POST(request(body))).status).toBe(400);
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("본문 실제 크기를 제한하고 잘못된 JSON을 저장하지 않는다", async () => {
    const db = client();
    expect((await POST(request({ version: "x".repeat(2000), hideForVersion: false }))).status).toBe(413);
    expect((await POST(new Request("https://rescue.example/api/user-guide", { method: "POST", headers: { Origin: "https://rescue.example", "Content-Type": "application/json" }, body: "{" }))).status).toBe(400);
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("외부 출처·Origin 누락·JSON 아닌 요청은 인증 설정을 조회하기 전에 거부한다", async () => {
    const db = client();
    expect((await POST(request(undefined, { Origin: "https://attacker.example" }))).status).toBe(403);
    expect((await POST(request(undefined, { Origin: "" }))).status).toBe(403);
    expect((await POST(request(undefined, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("빈 세션이나 인증 사용자와 다른 서명된 sub로 설정을 저장하지 않는다", async () => {
    const db = client();
    for (const claims of [{ sub: "other-user", session_id: sessionId }, { sub: userId }, { sub: userId, session_id: "bad" }]) {
      db.auth.getClaims.mockResolvedValue({ data: { claims }, error: null } as never);
      expect((await POST(request())).status).toBe(503);
    }
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("검증된 세션 조회 실패를 설정 저장 성공으로 바꾸지 않는다", async () => {
    const db = client();
    db.auth.getClaims.mockResolvedValue({ data: null, error: { message: "signature error" } } as never);
    const response = await GET(readRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ available: false });
    expect((await POST(request())).status).toBe(503);
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("Auth 쓰기 오류·빈 결과·반영되지 않은 결과를 성공으로 응답하지 않는다", async () => {
    const db = client();
    for (const result of [
      { data: { user: null }, error: { message: "failure" } },
      { data: { user: null }, error: null },
      { data: { user: { id: userId, user_metadata: {} } }, error: null },
      { data: { user: { id: "other-user", user_metadata: createUserGuideMetadataPatch(false) } }, error: null },
    ]) {
      db.auth.updateUser.mockResolvedValue(result as never);
      const response = await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: true }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ available: false });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("숨기기 해제 결과 필드가 누락되면 성공이나 닫기 쿠키를 내보내지 않는다", async () => {
    const db = client(createUserGuideMetadataPatch(true));
    db.auth.updateUser.mockResolvedValue({ data: { user: { id: userId, user_metadata: {} } }, error: null });
    const response = await POST(request({ version: USER_GUIDE_VERSION, hideForVersion: false }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("사용자별 레이트리밋에 걸리면 Auth 쓰기를 중단하고 재시도 시간을 보낸다", async () => {
    const db = client();
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 20 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("20");
    expect(mocks.rateLimit).toHaveBeenCalledWith(`user-guide:write:${userId}`, 20, 60_000);
    expect(db.auth.getClaims).not.toHaveBeenCalled();
    expect(db.auth.updateUser).not.toHaveBeenCalled();
  });

  it("실제 백엔드 없는 데모는 영속 설정 불가를 명시하고 쓰기 성공을 가장하지 않는다", async () => {
    mocks.demo = true;
    expect(await (await GET(readRequest())).json()).toEqual({ version: USER_GUIDE_VERSION, shouldShow: false, hideForVersion: false, available: false });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
