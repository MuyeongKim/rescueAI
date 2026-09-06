import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), limit: vi.fn(), tooManyRequests: vi.fn(), external: vi.fn(),
  reader: vi.fn(), native: vi.fn(), client: {},
}));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit, tooManyRequests: mocks.tooManyRequests }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.client }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: () => ({ verifySourceEvidence: mocks.reader }) }));
vi.mock("@/lib/rag-external", () => ({ ragTableEnabled: mocks.external }));
vi.mock("@/lib/source-provenance", async (original) => ({
  ...await original<typeof import("@/lib/source-provenance")>(),
  verifyNativeDocumentSourceProvenance: mocks.native,
}));

import { POST } from "@/app/api/generate/section-evidence/route";
import { findDocumentSectionEvidence } from "@/lib/document-section-evidence";

const source = { document_id: 54, doc: "구급 교재", page: 270 };
const section = { heading: "안전관리", content: "관통 이물과 환자 상태를 확인한다." };
const chunk = { source, content: "원문 시작. 관통 이물과 환자 상태를 확인하고 교관에게 보고한다. 원문 끝." };
const request = (body: unknown) => new Request("http://localhost/api/generate/section-evidence", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const validBody = () => ({ category: "구급", section, sources: [source] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner-1" } });
  mocks.limit.mockReturnValue({ ok: true });
  mocks.tooManyRequests.mockImplementation((seconds) => Response.json({ seconds }, { status: 429 }));
  mocks.external.mockReturnValue(true);
  mocks.reader.mockResolvedValue({ sources: [source], degraded: false, evidenceChunks: [chunk] });
});

describe("문단 근거 조회 요청 경계", () => {
  it("인증과 레이트리밋을 JSON 파싱과 원문 조회보다 먼저 수행한다", async () => {
    mocks.auth.mockResolvedValueOnce({ ok: false, response: new Response("Unauthorized", { status: 401 }) });
    expect((await POST(request("{"))).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
    mocks.limit.mockReturnValueOnce({ ok: false, retryAfterSec: 15 });
    expect((await POST(request("{"))).status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("generation-section-evidence:owner-1", 30, 60_000);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(15);
    expect(mocks.reader).not.toHaveBeenCalled();
  });

  it("허용 크기 밖 요청과 잘못된 출처는 원문 조회 전에 거절한다", async () => {
    expect((await POST(request({ ...validBody(), section: { ...section, content: "x".repeat(130_000) } }))).status).toBe(413);
    expect((await POST(request({ ...validBody(), sources: [{ ...source, page: 0 }] }))).status).toBe(400);
    expect(mocks.reader).not.toHaveBeenCalled();
  });

  it.each([
    ["위조", []],
    ["비활성으로 회수되지 않음", []],
    ["다른 페이지", [{ ...source, page: 271 }]],
    ["다른 제목", [{ ...source, doc: "다른 교재" }]],
  ])("%s 출처를 현재 원문과 동일한 근거로 반환하지 않는다", async (_name, sources) => {
    mocks.reader.mockResolvedValue({ sources, degraded: false, evidenceChunks: [chunk] });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(422);
    expect(await response.json()).not.toHaveProperty("items");
  });

  it("조회 장애는 빈 정상 목록으로 표시하지 않는다", async () => {
    mocks.reader.mockResolvedValueOnce({ sources: [source], degraded: true, evidenceChunks: [chunk] });
    expect((await POST(request(validBody()))).status).toBe(503);
    mocks.reader.mockRejectedValueOnce(new Error("offline"));
    expect((await POST(request(validBody()))).status).toBe(503);
  });

  it("원문과 정확한 페이지를 반환하고 클라이언트가 넣은 인용문을 버린다", async () => {
    const response = await POST(request({ ...validBody(), sources: [{ ...source, excerpt: "위조 인용" }], evidenceChunks: [{ source, content: "위조 인용" }] }));
    expect(response.status).toBe(200);
    expect(mocks.reader).toHaveBeenCalledWith([source], "구급");
    expect(await response.json()).toEqual({ items: [{ source, excerpt: chunk.content, matchKind: "text-overlap" }], scope: "related-source-excerpts" });
  });

  it("기본 자료 설치에서도 실제 원문을 포함한 동일 검증 경로를 사용한다", async () => {
    mocks.external.mockReturnValue(false);
    mocks.native.mockResolvedValue({ sources: [source], degraded: false, evidenceChunks: [chunk] });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.native).toHaveBeenCalledWith([source], "구급", mocks.client, true);
    expect(mocks.reader).not.toHaveBeenCalled();
  });
});

describe("원문 구절 추출", () => {
  it("다른 청크의 문장을 합쳐 인용을 만들지 않고 정확한 원문 부분 문자열을 유지한다", () => {
    const chunks = [
      { source, content: "관통 이물은 첫 번째 청크에서 확인한다." },
      { source: { ...source, page: 271 }, content: "환자 상태는 두 번째 청크에서 확인한다." },
      { source: { ...source, page: 272 }, content: "관통 이물과 환자 상태를 함께 확인하는 세 번째 원문." },
    ];
    const items = findDocumentSectionEvidence(section, chunks);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const original = chunks.find((candidate) => candidate.source.document_id === item.source.document_id && candidate.source.page === item.source.page)!;
      expect(original.content).toContain(item.excerpt);
      expect(item.excerpt.length).toBeLessThanOrEqual(500);
    }
    expect(items.some((item) => item.excerpt.includes("첫 번째 청크") && item.excerpt.includes("두 번째 청크"))).toBe(false);
  });

  it("흔한 교육 단어만 겹친 페이지를 제외하고 페이지 중복과 최대 개수를 제한한다", () => {
    expect(findDocumentSectionEvidence({ heading: "훈련", content: "대원 교관 교육 확인 자료" }, [{ source, content: "대원 교관 교육 확인 자료" }])).toEqual([]);
    const chunks = Array.from({ length: 8 }, (_, index) => ({ source: { ...source, page: index + 1 }, content: `관통 이물과 환자 상태 근거 ${index}` }));
    const items = findDocumentSectionEvidence(section, [...chunks, chunks[0]]);
    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.source.page)).size).toBe(4);
  });
});
