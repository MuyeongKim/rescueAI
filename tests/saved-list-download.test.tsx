import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedMaterial } from "@/lib/generate";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), hwpx: vi.fn(), pptx: vi.fn(), visuals: vi.fn(),
  error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("@/lib/hwpx-download", () => ({ downloadHwpx: mocks.hwpx }));
vi.mock("@/lib/pptx", () => ({ downloadPptx: mocks.pptx }));
vi.mock("@/lib/source-visuals", () => ({ prepareDeckSourceVisuals: mocks.visuals }));
// These tests isolate the download transport boundary; local content validation has separate coverage.
vi.mock("@/lib/generate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/generate")>(),
  inspectCurrentGenerationQuality: () => ({ ok: true, issues: [] }),
}));
import { SavedList } from "@/components/generate/SavedList";

const material: SavedMaterial = {
  id: 12, kind: "plan", title: "산악사고 훈련", category: "산악", topic: "산악사고 대비",
  audience: "일반 대원", duration: "2시간", created_at: "2026-09-06T00:00:00.000Z",
  content: {
    sections: [{ heading: "훈련내용", content: "저장한 원문 내용" }],
    sources: [{ document_id: 54, doc: "구조 교재", page: 3 }],
    sopEvidence: { status: "not_found", sourceLabels: [] },
    focus: "장비 확인", conditions: "장비 제한", date: "2026-09-07", place: "훈련장",
  },
};

function findDownload(node: ReactNode, label: string): () => Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) {
      try { return findDownload(child, label); } catch { /* Try the next sibling. */ }
    }
  } else if (isValidElement<{ children?: ReactNode; onClick?: () => Promise<void> }>(node)) {
    const children = node.props.children;
    if (node.props.onClick && Array.isArray(children) && children.includes(label)) return node.props.onClick;
    if (children) return findDownload(children, label);
  }
  throw new Error(`Download control not found: ${label}`);
}

function download(item = material, mode: "own" | "shared" = "own") {
  return findDownload(SavedList({ initial: [item], mode }), item.kind === "slides" ? "PPTX" : item.kind === "notebooklm" ? "프롬프트 복사" : "한글(hwpx)");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue(Response.json({ ok: true }));
  mocks.hwpx.mockResolvedValue("remote");
});
afterEach(() => vi.unstubAllGlobals());

describe("저장 목록 다운로드의 현재 원문 검증", () => {
  it.each(["own", "shared"] as const)("%s 목록도 검증이 끝난 뒤에만 파일을 생성한다", async (mode) => {
    let complete!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { complete = resolve; }));
    const pending = download(material, mode)();
    expect(mocks.hwpx).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith("/api/generate/verify", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
      kind: material.kind, title: material.title, category: material.category, topic: material.topic,
      audience: material.audience, duration: material.duration, content: material.content,
    });
    complete(Response.json({ ok: true }));
    await pending;
    expect(mocks.hwpx).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([409, 422, 503])("HTTP %s 원문·SOP 변경/조회 실패를 파일 생성 전에 차단하고 이유를 보여준다", async (status) => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "현재 원본의 출처 또는 SOP 상태가 바뀌었습니다." }, { status }));
    await download()();
    expect(mocks.hwpx).not.toHaveBeenCalled();
    expect(mocks.pptx).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("다운로드에 실패했습니다", { description: "현재 원본의 출처 또는 SOP 상태가 바뀌었습니다." });
  });

  it.each([{ ok: true, degraded: true }, { ok: false }, null])("성공 응답에도 근거 확인이 불완전하면 다운로드하지 않는다: %j", async (payload) => {
    mocks.fetch.mockResolvedValueOnce(Response.json(payload));
    await download()();
    expect(mocks.hwpx).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("네트워크 실패 뒤 잠금을 풀어 다시 검증하고 다운로드할 수 있다", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const click = download();
    await click();
    expect(mocks.hwpx).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("다운로드에 실패했습니다", { description: expect.stringContaining("원문 근거 확인에 연결하지 못해") });
    await click();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.hwpx).toHaveBeenCalledOnce();
  });

  it("같은 렌더의 연속 클릭도 중복 검증·다운로드를 만들지 않는다", async () => {
    let complete!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { complete = resolve; }));
    const click = download();
    const pending = click();
    await click();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    complete(Response.json({ ok: true }));
    await pending;
    expect(mocks.hwpx).toHaveBeenCalledOnce();
  });

  it("PPTX도 검증 실패 시 이미지 준비와 파일 생성을 시작하지 않는다", async () => {
    const slides = { ...material, kind: "slides" as const, content: { ...material.content, slides: [{ title: "첫 장", bullets: ["내용"], notes: "설명" }] } };
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "비활성 출처입니다." }, { status: 422 }));
    await download(slides)();
    expect(mocks.visuals).not.toHaveBeenCalled();
    expect(mocks.pptx).not.toHaveBeenCalled();
  });

  it("PPTX 검증 성공 뒤 저장한 슬라이드로 이미지를 준비하고 파일을 만든다", async () => {
    const slides = { ...material, kind: "slides" as const, content: { ...material.content, slides: [{ title: "첫 장", bullets: ["내용"], notes: "설명" }] } };
    mocks.visuals.mockImplementationOnce(async (deck) => ({ deck, requested: 0, resolved: 0, failed: 0, fallbacks: [] }));
    await download(slides, "shared")();
    expect(mocks.visuals).toHaveBeenCalledOnce();
    expect(mocks.pptx).toHaveBeenCalledWith(expect.objectContaining({ slides: [expect.objectContaining({ title: "첫 장", bullets: ["내용"] })] }), "산악", "대상: 일반 대원 · 교육 시간: 2시간");
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("검증 응답을 읽을 수 없어도 파일을 만들지 않는다", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("not JSON", { status: 200 }));
    await download()();
    expect(mocks.hwpx).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("기존 NotebookLM 프롬프트 복사는 검증 요청 없이 유지한다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await download({ ...material, kind: "notebooklm", content: { prompt: "기존 프롬프트" } })();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("기존 프롬프트");
  });
});
