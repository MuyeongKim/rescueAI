import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { buildPptxBytes } from "@/lib/pptx";
import { generatedPptxSlideCount, planPptxSourceAppendix } from "@/lib/pptx-plan";
import { buildSlideLayoutPlan, inspectSlideDeckLayout } from "@/lib/slide-layout";
import { conservativeSlideTextMeasure, fitSlideText, wrapSlideText } from "@/lib/slide-text";
import type { GeneratedSlideDeck } from "@/lib/generate";

const compact = (text: string) => text.normalize("NFC").replace(/\s/g, "");
const deck: GeneratedSlideDeck = { title: "교육 검증", slides: [{ title: "상태 확인", bullets: ["진입 전 상태를 확인합니다."], notes: "교관 설명" }], sources: [] };

describe("한글 글폭과 전문 보존", () => {
  it("NFD로 저장된 한글은 NFC와 같은 줄 수로 배치하고 자모 중간을 나누지 않는다", () => {
    const text = "재난현장 표준작전절차 구조대원 안전관리 지침";
    const decomposed = text.normalize("NFD");
    expect(conservativeSlideTextMeasure(decomposed, 20, false)).toBe(conservativeSlideTextMeasure(text, 20, false));
    expect(wrapSlideText(decomposed, 140, 20)).toEqual(wrapSlideText(text, 140, 20));
    expect(compact(wrapSlideText(decomposed, 140, 20).join(""))).toBe(compact(text));
  });

  it("긴 한글·영문·수치의 줄바꿈에서 의미 있는 글자를 삭제하지 않는다", () => {
    const text = "현장에서는 SCBA 장비의 상태와 100% 기준값을 먼저 확인합니다.\nSupercalifragilisticexpialidocious 명칭도 보존합니다.";
    const fitted = fitSlideText(text, { x: 0, y: 0, w: 3, h: 6 }, [22, 20, 18]);
    expect(fitted.fits).toBe(true);
    expect(compact(fitted.lines.join(""))).toBe(compact(text));
  });

  it("마침표·닫는 괄호를 줄 첫 글자로, 여는 괄호를 줄 끝 글자로 남기지 않는다", () => {
    const text = '훈련을 확인합니다. [조건 확인] (중단 보고) "질문 확인" 다음 절차';
    const lines = wrapSlideText(text.normalize("NFD"), 94, 20);
    expect(compact(lines.join(""))).toBe(compact(text));
    expect(lines.some((line) => /^[.,;:!?\])}]/.test(line))).toBe(false);
    expect(lines.some((line) => /[(\[{]$/.test(line))).toBe(false);
    expect(lines).not.toContain(".");
    expect(lines).not.toContain('"');
  });

  it("긴 그림 설명은 원문을 유지하고 이미지 아래 높이를 늘린다", () => {
    const caption = "재난현장 표준작전절차와 구조대원 안전관리 지침의 정확한 원문 제목을 확인합니다. ".repeat(3).trim().normalize("NFD");
    const plan = buildSlideLayoutPlan({ ...deck.slides[0], composition: "visual-explanation", visual: { mode: "source-page", documentId: 1, page: 1, caption } });
    expect(plan.issues).toEqual([]);
    const item = plan.texts.find((text) => text.id === "image-caption")!;
    expect(item.text).toBe(caption);
    expect(compact(item.lines.join(""))).toBe(compact(caption));
    expect(item.h).toBeGreaterThan(0.66);
    expect(item.y + item.h).toBeLessThan(6.96);
    expect(plan.image!.y + plan.image!.h).toBeLessThan(item.y);
  });

  it("정상 출처명 300자를 전문 보존한 부록 페이지 수와 실제 PPT 장수가 같다", async () => {
    const sources = [0, 1, 2].map((index) => ({ document_id: index + 1, doc: (`${index + 1}번 문서 ` + "구조대원안전관리".repeat(40)).slice(0, 300), page: index + 1 }));
    expect(sources.every((source) => source.doc.length === 300)).toBe(true);
    const input = { ...deck, sources };
    const pages = planPptxSourceAppendix(sources);
    expect(pages.length).toBeGreaterThan(1);
    expect(inspectSlideDeckLayout(input).ok).toBe(true);
    for (const [index, source] of sources.entries()) {
      const rows = pages.flat().filter((row) => row.sourceIndex === index);
      expect(compact(rows.flatMap((row) => row.lines).join(""))).toBe(compact(source.doc));
      expect(rows.every((row) => row.y + row.h <= 6.44)).toBe(true);
    }
    const zip = await JSZip.loadAsync(await buildPptxBytes(input, "일반구조", ""));
    const paths = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(paths).toHaveLength(generatedPptxSlideCount(input.slides.length, sources));
    for (const [pageIndex, rows] of pages.entries()) {
      const xml = await zip.file(`ppt/slides/slide${input.slides.length + pageIndex + 2}.xml`)!.async("string");
      for (const row of rows) for (const line of row.lines) expect(xml).toContain(line);
      expect(xml).toContain('sz="1800"');
    }
  });

  it("아주 긴 과거 출처명도 계속 페이지로 나눠 이름 중간을 버리지 않는다", () => {
    const source = { document_id: 1, doc: "원문자료의긴정확한이름".repeat(120), page: null };
    const pages = planPptxSourceAppendix([source]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[1][0].continuation).toBe(true);
    expect(compact(pages.flat().flatMap((row) => row.lines).join(""))).toBe(source.doc);
  });

  it("16pt에서도 본문이 넘치면 파일 생성을 차단하며 노트에 조용히 밀어 넣지 않는다", async () => {
    const input = { ...deck, slides: [{ ...deck.slides[0], bullets: ["안전 조건과 절차를 확인합니다. ".repeat(120)] }] };
    await expect(buildPptxBytes(input, "일반구조", "")).rejects.toMatchObject({ name: "SlideLayoutError", issues: expect.arrayContaining([expect.objectContaining({ path: "slides.0.bullets.0", severity: "error" })]) });
  });
});

describe("브라우저 글꼴 준비 실패 경계", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it("CSS에 같은 이름의 글꼴이 없으면 fallback check가 참이어도 거부한다", async () => {
    vi.stubGlobal("document", { fonts: { load: vi.fn().mockResolvedValue([]), check: () => true } });
    const { prepareSlideTextMeasurer } = await import("@/lib/slide-text-browser");
    await expect(prepareSlideTextMeasurer()).rejects.toThrow("슬라이드 글꼴을 준비하지 못했습니다");
  });
  it("폰트 요청 실패는 PPTX 다운로드까지 전파한다", async () => {
    vi.stubGlobal("document", { fonts: { load: vi.fn().mockRejectedValue(new Error("폰트 요청 실패")), check: () => false } });
    await expect(buildPptxBytes(deck, "일반구조", "")).rejects.toThrow("폰트 요청 실패");
  });
  it("실제 canvas 폭은 px에서 pt로 바꾸며 준비 작업을 공유한다", async () => {
    const measureText = vi.fn().mockReturnValue({ width: 120 });
    const load = vi.fn().mockResolvedValue([{}]);
    vi.stubGlobal("document", { fonts: { load, check: () => true }, createElement: () => ({ getContext: () => ({ measureText, font: "" }) }) });
    const { prepareSlideTextMeasurer } = await import("@/lib/slide-text-browser");
    const [first, second] = await Promise.all([prepareSlideTextMeasurer(), prepareSlideTextMeasurer()]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
    expect(first("훈련".normalize("NFD"), 24, true)).toBe(90);
    expect(measureText).toHaveBeenCalledWith("훈련");
  });
});
