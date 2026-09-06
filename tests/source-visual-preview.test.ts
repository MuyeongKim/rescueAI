import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedSlideDeck } from "@/lib/generate";
import { prepareDeckSourceVisuals } from "@/lib/source-visuals";

const pdf = vi.hoisted(() => ({ render: vi.fn(), open: vi.fn() }));
vi.mock("react-pdf", () => ({ pdfjs: {
  GlobalWorkerOptions: {}, OPS: { paintImageXObject: 1 },
  getDocument: (...args: unknown[]) => {
    pdf.open(...args);
    return { promise: Promise.resolve({ numPages: 5, destroy: async () => undefined,
      getPage: async (page: number) => ({
        getOperatorList: async () => ({ fnArray: Array(page === 1 ? 1 : 6).fill(1) }),
        getTextContent: async () => ({ items: [{ str: "원문 도해" }] }),
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 400 * scale }),
        render: (options: unknown) => { pdf.render(page, options); return { promise: Promise.resolve() }; }, cleanup: () => undefined,
      }),
    }) };
  },
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("원문 그림 사전 확인과 다운로드", () => {
  it("선택 범위를 PDF에서 선명하게 다시 렌더하고 전체 원문도 보존하며 캐시 접근 권한을 재검증한다", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { createElement: () => {
      const canvas = { width: 1, height: 1, getContext: () => ({}), toDataURL: () => `data:image/jpeg;base64,${canvas.width}x${canvas.height}` };
      return canvas;
    } });
    const fetchSource = vi.fn(async () => new Response(JSON.stringify({ url: "https://example.test/focus.pdf", title: "확대 교범" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSource);
    const slide = { title: "원문 확대", bullets: ["그림을 확인합니다"], notes: "설명", composition: "visual-explanation" as const,
      sourceRefs: ["[확대 교범 p.1]"], visual: { mode: "source-page" as const, documentId: 77002, page: 1, sourceRef: "[확대 교범 p.1]", sourceFocus: "bottom" as const } };
    const deck: GeneratedSlideDeck = { title: "확대", slides: [slide], sources: [{ document_id: 77002, doc: "확대 교범", page: 1 }] };
    const preview = await prepareDeckSourceVisuals(deck);
    expect(preview.resolved).toBe(1);
    expect(preview.deck.slides[0].visual).toMatchObject({ sourceFocus: "bottom", imageData: "data:image/jpeg;base64,1200x400", sourcePageImageData: "data:image/jpeg;base64,1200x800" });
    expect(pdf.render).toHaveBeenCalledTimes(2);
    expect(pdf.render.mock.calls[1][1]).toMatchObject({ transform: [1, 0, 0, 1, -0, -400] });

    const download = await prepareDeckSourceVisuals(deck);
    expect(download.deck.slides[0].visual).toEqual(preview.deck.slides[0].visual);
    expect(pdf.render).toHaveBeenCalledTimes(2);
    expect(fetchSource).toHaveBeenCalledTimes(2);
    const full = await prepareDeckSourceVisuals({ ...deck, slides: [{ ...slide, visual: { ...slide.visual, sourceFocus: undefined } }] });
    expect(full.deck.slides[0].visual?.imageData).toBe("data:image/jpeg;base64,1200x800");
    expect(full.deck.slides[0].visual?.sourcePageImageData).toBeUndefined();
    expect(full.deck.slides[0].visual?.sourceFocus).toBeUndefined();

    fetchSource.mockImplementationOnce(async () => new Response("{}", { status: 403 }));
    const denied = await prepareDeckSourceVisuals(deck);
    expect(denied.resolved).toBe(0);
    expect(denied.deck.slides[0].visual?.imageData).toBeUndefined();
    expect(denied.deck.slides[0].visual?.sourcePageImageData).toBeUndefined();
  });
  it("선택 페이지를 우선하고 확인한 그림을 재사용하되 현재 접근 권한을 다시 확인한다", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { createElement: () => ({ width: 1, height: 1, getContext: () => ({}), toDataURL: () => "data:image/jpeg;base64,cHJldmlldw==" }) });
    const fetchSource = vi.fn(async () => new Response(JSON.stringify({ url: "https://example.test/authorized.pdf", title: "검토 교범" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSource);
    const deck: GeneratedSlideDeck = {
      title: "원문 확인", sources: [{ document_id: 77001, doc: "검토 교범", page: 1 }, { document_id: 77001, doc: "검토 교범", page: 2 }],
      slides: [{ title: "선택한 그림", bullets: ["장비 위치를 확인합니다", "그림과 장비를 비교합니다"], notes: "설명", composition: "visual-explanation", sourceRefs: ["[검토 교범 p.1]", "[검토 교범 p.2]"], visual: { mode: "source-page", documentId: 77001, page: 1, sourceRef: "[검토 교범 p.1]", altText: "첫 번째 그림" } }],
    };
    const preview = await prepareDeckSourceVisuals(deck);
    expect(preview.resolved).toBe(1);
    expect(preview.deck.slides[0].visual?.page).toBe(1);
    expect(pdf.render).toHaveBeenCalledTimes(1);

    const download = await prepareDeckSourceVisuals({ ...deck, slides: [deck.slides[0], deck.slides[0]] });
    expect(download.resolved).toBe(2);
    expect(download.deck.slides.map((slide) => slide.visual?.page)).toEqual([1, 1]);
    expect(pdf.render).toHaveBeenCalledTimes(1);
    expect(fetchSource).toHaveBeenCalledTimes(2);
    expect(deck.slides[0].visual?.imageData).toBeUndefined();

    fetchSource.mockImplementationOnce(async () => new Response(JSON.stringify({ url: "https://example.test/replaced.pdf" }), { status: 200 }));
    await prepareDeckSourceVisuals(deck);
    expect(pdf.render).toHaveBeenCalledTimes(2);

    fetchSource.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "접근할 수 없습니다" }), { status: 403 }));
    const denied = await prepareDeckSourceVisuals(deck);
    expect(denied.resolved).toBe(0);
    expect(denied.deck.slides[0].visual?.imageData).toBeUndefined();
    expect(denied.fallbacks[0].reason).toBe("source-unavailable");
  });
});
