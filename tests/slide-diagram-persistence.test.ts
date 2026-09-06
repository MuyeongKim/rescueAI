import { describe, expect, it } from "vitest";
import type { GeneratedSlide, GeneratedSlideDeck, SavedMaterial } from "@/lib/generate";
import { hydrateMaterial, stripSlideDeckRuntimeData } from "@/lib/generate-material";
import { normalizeGeneratedMaterialContent } from "@/lib/generated-material-save";
import { generationDraftSnapshotSchema, restoreGenerationDraft } from "@/lib/generation-draft";
import { generationTextParts } from "@/lib/generation-grounding";
import { applyGenerationReviewDraftEdit, projectGenerationReviewDraft } from "@/lib/generation-job-review";
import type { Json } from "@/lib/database.types";

const slides: GeneratedSlide[] = [
  { title: "진행 순서", bullets: ["설명 A", "설명 B"], steps: ["준비", "확인"], notes: "진행 설명", composition: "process",
    diagram: { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] }] } },
  { title: "차이 비교", bullets: ["A의 설명", "B의 설명"], steps: ["A 기준", "B 기준", "확인 항목"], notes: "차이 설명", composition: "comparison",
    diagram: { kind: "comparison", columnStepIndices: [0, 1], rows: [{ labelStepIndex: 2, cells: [[0], [1]] }] } },
  { title: "판단 기준", bullets: ["교육을 이어갑니다", "설명을 다시 확인합니다"], steps: ["설명을 이해했습니까?", "이해함", "질문 있음"], notes: "확인 설명", composition: "decision-flow",
    diagram: { kind: "decision", conditionStepIndex: 0, branches: [{ labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1] }] } },
];
const deck: GeneratedSlideDeck = { title: "도식 저장 검증", mode: "presenter", slides, sources: [] };
const material = (content: unknown): SavedMaterial => ({ id: 1, revision: 1, kind: "slides", title: deck.title,
  category: "현장지휘·공통", audience: "일반 대원", duration: "1시간", topic: "교육 진행", content: content as SavedMaterial["content"], created_at: "2026-09-06T00:00:00Z" });

describe("도식 생성·저장·복원·근거 검토 연결", () => {
  it("모든 도식의 관계가 런타임 제거와 서버 저장 정규화 및 재편집을 왕복한다", () => {
    const normalized = normalizeGeneratedMaterialContent("slides", stripSlideDeckRuntimeData(deck));
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const restored = hydrateMaterial(material(normalized.content)).deck!;
    expect(restored.slides).toEqual(slides);
    expect(generationTextParts(restored)[2].text).toContain("이해함 → 교육을 이어갑니다");
    expect(generationTextParts(restored)[2].text).toContain("질문 있음 → 설명을 다시 확인합니다");
  });

  it("미완성 편집 초안에서도 도식과 본문을 함께 복구한다", () => {
    const snapshot = generationDraftSnapshotSchema.parse({ version: 1, kind: "slides", deck, doc: null, nlm: null,
      context: { category: "현장지휘·공통", audience: "일반 대원", duration: "1시간", topic: "교육 진행", focus: "", conditions: "", date: "", place: "", slideMode: "presenter" },
      materialId: null, materialRevision: null, saved: false });
    expect(restoreGenerationDraft(snapshot).deck!.slides).toEqual(slides);
  });

  it("단계 상한을 넘긴 미완성 입력은 초안에 보존하고 공식 저장에서는 거절한다", () => {
    const unfinished = { ...deck, slides: [{ ...slides[0], diagram: undefined, steps: Array.from({ length: 7 }, (_, i) => `확인 단계 ${i + 1}`) }] };
    const stripped = stripSlideDeckRuntimeData(unfinished);
    const snapshot = generationDraftSnapshotSchema.parse({ version: 1, kind: "slides", deck: stripped, doc: null, nlm: null,
      context: { category: "현장지휘·공통", audience: "일반 대원", duration: "1시간", topic: "교육 진행", focus: "", conditions: "", date: "", place: "", slideMode: "presenter" },
      materialId: null, materialRevision: null, saved: false });
    expect(restoreGenerationDraft(snapshot).deck!.slides[0].steps).toEqual(unfinished.slides[0].steps);
    expect(normalizeGeneratedMaterialContent("slides", stripped).ok).toBe(false);
  });

  it("저장 시 누락·중복·범위 밖 연결을 조용히 지우지 않고 거절한다", () => {
    for (const indices of [[0], [0, 0], [3]]) {
      const invalid = { ...slides[0], diagram: { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: indices }, { stepIndex: 1, bulletIndices: [] }] } };
      expect(normalizeGeneratedMaterialContent("slides", { slides: [invalid] })).toMatchObject({ ok: false, error: expect.stringContaining("1번 슬라이드") });
    }
  });

  it("구형 자료의 잘못된 본문 제거로 번호가 바뀌면 관계를 해제하고 남은 본문을 보존한다", () => {
    const invalidStored = { ...slides[0], bullets: ["", ...slides[0].bullets] };
    const restored = hydrateMaterial(material({ slides: [invalidStored] })).deck!.slides[0];
    expect(restored.bullets).toEqual(slides[0].bullets);
    expect(restored.diagram).toBeUndefined();
  });

  it("분기 행동을 바꾸면 근거 검토에 전달하는 관계도 바뀐다", () => {
    const reversed = { ...slides[2], diagram: { kind: "decision" as const, conditionStepIndex: 0,
      branches: [{ labelStepIndex: 1, bulletIndices: [1] }, { labelStepIndex: 2, bulletIndices: [0] }] } };
    const text = generationTextParts({ ...deck, slides: [reversed] })[0].text;
    expect(text).toContain("이해함 → 설명을 다시 확인합니다");
    expect(text).not.toContain("이해함 → 교육을 이어갑니다");
  });

  it("미검증 초안에서 본문 수정·명시 해제는 이전 연결을 없애고 제목만 수정하면 유지한다", () => {
    const checkpoint = JSON.parse(JSON.stringify({ outline: { title: deck.title }, slides, groundingReview: { signature: "old" } })) as Json;
    const edits = slides.map(({ title, bullets, notes, steps }) => ({ title, bullets, notes, steps }));
    const project = projectGenerationReviewDraft(checkpoint)!;
    expect((project.slides as GeneratedSlide[])[2].diagram).toEqual(slides[2].diagram);
    const unchanged = applyGenerationReviewDraftEdit(checkpoint, "slides", { title: "제목만 수정합니다", slides: edits }) as { slides: GeneratedSlide[] };
    expect(unchanged.slides[2].diagram).toEqual(slides[2].diagram);
    const changed = applyGenerationReviewDraftEdit(checkpoint, "slides", { title: deck.title, slides: edits.map((slide, index) => index === 2 ? { ...slide, bullets: [...slide.bullets].reverse() } : slide) }) as { slides: GeneratedSlide[]; groundingReview?: unknown };
    expect(changed.slides[2].diagram).toBeUndefined();
    expect(changed.groundingReview).toBeUndefined();
    const cleared = applyGenerationReviewDraftEdit(checkpoint, "slides", { title: deck.title, slides: edits.map((slide, index) => index === 2 ? { ...slide, clearDiagram: true } : slide) }) as { slides: GeneratedSlide[] };
    expect(cleared.slides[2].diagram).toBeUndefined();
    expect(cleared.slides[2].bullets).toEqual(slides[2].bullets);
  });
});
