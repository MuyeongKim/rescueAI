import { describe, expect, it } from "vitest";
import { bindSlideVisualsToSources, generatedSlideSchema, type GeneratedSlideDeck } from "@/lib/generate";
import { hydrateMaterial, stripSlideDeckRuntimeData } from "@/lib/generate-material";
import { normalizeGeneratedMaterialContent, readLimitedJsonBody, rebindNormalizedSlideContent } from "@/lib/generated-material-save";
import { buildSlideLayoutPlan } from "@/lib/slide-layout";
import { sourceVisualFocusRegion, validSourceVisualFocus } from "@/lib/source-visual-focus";
import { generationDraftSnapshotSchema, restoreGenerationDraft } from "@/lib/generation-draft";

const deck: GeneratedSlideDeck = {
  title: "그림의 필요한 부분을 확인합니다",
  sources: [{ document_id: 7, doc: "장비 교범", page: 3 }],
  slides: [{ title: "연결 부위를 확인합니다", bullets: ["설명과 주의사항을 함께 확인합니다"], notes: "교관 설명",
    composition: "visual-explanation", sourceRefs: ["[장비 교범 p.3]"], visual: {
      mode: "source-page", sourceRef: "[장비 교범 p.3]", documentId: 7, page: 3,
      sourceFocus: "middle", imageData: "data:image/jpeg;base64,AAAA", sourcePageImageData: "data:image/jpeg;base64,BBBB",
    } }],
};

describe("사용자가 선택한 원문 확대 범위", () => {
  it("고정 범위만 허용하고 오래된 임의 좌표는 전체 표시로 취급한다", () => {
    expect(sourceVisualFocusRegion("top")).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(sourceVisualFocusRegion("middle")).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
    expect(sourceVisualFocusRegion("bottom")).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(sourceVisualFocusRegion({ x: 0.1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(validSourceVisualFocus("full")).toBeUndefined();
  });

  it("모델 출력 스키마에서는 확대 범위와 원문 이미지가 제외된다", () => {
    const parsed = generatedSlideSchema.parse(deck.slides[0]);
    expect(parsed.visual).not.toHaveProperty("sourceFocus");
    expect(parsed.visual).not.toHaveProperty("sourcePageImageData");
  });

  it("정식 저장과 재열람에서는 범위만 보존하고 런타임 이미지는 제거한다", () => {
    const stripped = stripSlideDeckRuntimeData(deck);
    expect(stripped.slides[0].visual).toMatchObject({ sourceFocus: "middle" });
    expect(JSON.stringify(stripped)).not.toMatch(/imageData|sourcePageImageData/);
    const normalized = normalizeGeneratedMaterialContent("slides", deck);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const rebound = rebindNormalizedSlideContent(normalized.content, deck.sources);
    expect(rebound).toMatchObject({ slides: [{ visual: { sourceFocus: "middle" } }] });
    const hydrated = hydrateMaterial({ id: 7, kind: "slides", category: "화재", audience: "일반 대원", duration: "1시간",
      topic: "장비", title: deck.title, content: rebound, revision: 1, created_at: "2026-09-06T00:00:00Z" });
    expect(hydrated.deck?.slides[0].visual?.sourceFocus).toBe("middle");
    expect(JSON.stringify(hydrated.deck)).not.toMatch(/imageData|sourcePageImageData/);
  });

  it("원문 ID가 달라지면 이전 페이지의 확대 범위를 재사용하지 않는다", () => {
    const rebound = bindSlideVisualsToSources(deck, [{ document_id: 8, doc: "장비 교범", page: 3 }]);
    expect(rebound.slides[0].visual?.documentId).toBe(8);
    expect(rebound.slides[0].visual?.sourceFocus).toBeUndefined();
  });

  it("미완성 초안에서 선택 범위를 복구하고 두 이미지 데이터는 보관하지 않는다", () => {
    const snapshot = generationDraftSnapshotSchema.parse({ version: 1, kind: "slides", deck, doc: null, nlm: null,
      context: { category: "화재", audience: "일반 대원", duration: "1시간", topic: "장비", focus: "", conditions: "", date: "", place: "", slideMode: "presenter" },
      materialId: null, materialRevision: null, saved: false });
    expect(restoreGenerationDraft(snapshot).deck?.slides[0].visual?.sourceFocus).toBe("middle");
    expect(JSON.stringify(snapshot.deck)).not.toMatch(/imageData|sourcePageImageData/);
  });

  it("확대 이미지 옆에 전체 원문과 실제 출처를 함께 배치한다", () => {
    const plan = buildSlideLayoutPlan(deck.slides[0]);
    expect(plan.image).toBeDefined();
    expect(plan.imageContext).toBeDefined();
    expect(plan.texts.find((item) => item.id === "image-caption")?.text).toContain("가운데 절반 확대");
    expect(plan.texts.find((item) => item.id === "image-caption")?.text).toContain("[장비 교범 p.3]");
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const full = buildSlideLayoutPlan({ ...deck.slides[0], visual: { ...deck.slides[0].visual!, sourceFocus: undefined } });
    expect(full.imageContext).toBeUndefined();
  });

  it("요청의 모든 깊이에서 두 종류의 런타임 이미지를 제거한다", async () => {
    const request = new Request("http://localhost/api/generate/save", { method: "POST", body: JSON.stringify({
      imageData: "large", sourcePageImageData: "large", nested: [{ sourcePageImageData: "large", sourceFocus: "top" }],
    }) });
    expect(await readLimitedJsonBody(request)).toEqual({ nested: [{ sourceFocus: "top" }] });
  });
});
