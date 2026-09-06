import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), reader: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, tooManyRequests: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: mocks.reader }));
vi.mock("@/lib/llm", () => ({ getChatModel: vi.fn() }));

import { POST as generate } from "@/app/api/generate/route";
import { POST as section } from "@/app/api/generate/section/route";
import { POST as evidence } from "@/app/api/generate/evidence/route";
import { POST as focus } from "@/app/api/generate/focus/route";

beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } }); mocks.rate.mockReturnValue({ ok: true }); });

describe("인터랙티브 생성 API의 SOP reader 권한 경계", () => {
  it.each([generate, section, evidence, focus])("인증 실패 시 SOP reader를 만들거나 본문을 읽지 않는다", async (post) => {
    mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const response = await post(new Request("http://localhost/api/generate", { method: "POST", body: "{" }));
    expect(response.status).toBe(401);
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
  });
  it.each([generate, section, evidence, focus])("호출 제한을 넘으면 SOP reader를 만들지 않는다", async (post) => {
    mocks.rate.mockReturnValue({ ok: false, retryAfterSec: 10 });
    const response = await post(new Request("http://localhost/api/generate", { method: "POST", body: "{" }));
    expect(response.status).toBe(429);
    expect(mocks.reader).not.toHaveBeenCalled();
  });
});
