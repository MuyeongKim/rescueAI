import { describe, expect, it, vi } from "vitest";
import { generationDraftKeySchema, generationDraftSnapshotSchema, generationDraftFingerprint, restoreGenerationDraft, type GenerationDraftSnapshot } from "@/lib/generation-draft";
import { categoryStyle } from "@/lib/category";
import { renderToStaticMarkup } from "react-dom/server";
import { GeneratedSourceLink } from "@/components/generate/GeneratedSourceLink";
import { GenerationRecoveryList } from "@/components/generate/GenerationRecoveryList";
import { buildDemoGeneration } from "@/lib/demo-generation";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

export function draftFixture(): GenerationDraftSnapshot {
  return { version: 1, kind: "plan", context: { category: "산악", audience: "일반 대원", duration: "1시간", topic: "로프 하강", focus: "확보", conditions: "대원 12명", date: "2026-09-06", place: "훈련탑", slideMode: "presenter" },
    doc: { title: "편집 중", sections: [{ heading: "훈련목표", content: "" }], sources: [] }, deck: null, nlm: null, materialId: null, materialRevision: null, saved: false };
}
describe("개인 편집 초안 계약", () => {
  it("데모도 세 자료 유형·모든 시간의 편집/저장 구조와 출처 계약을 만족한다", () => {
    for (const type of ["plan", "lesson", "slides"] as const) for (const duration of ["1시간", "2시간", "4시간"] as const) {
      const result = buildDemoGeneration({ type, category: "산악", topic: "로프 하강", audience: "일반 대원", duration });
      expect(result.demo).toBe(true);
      expect(result.sourceLabels?.length).toBeGreaterThan(0);
      expect(result.quality.errors, `${type} ${duration}`).toEqual([]);
      expect(result.quality.warnings.join(" ")).toContain("실제 RAG 검색이나 기술 사실 검증을 수행하지 않았습니다");
    }
  });
  it("편집 중 빈 본문도 소실 없이 복원하고 문서 일자·장소를 보존한다", () => {
    const parsed = generationDraftSnapshotSchema.parse(draftFixture());
    const restored = restoreGenerationDraft(parsed);
    expect(restored.doc?.sections[0].content).toBe("");
    expect(restored.date).toBe("2026-09-06");
    expect(restored.place).toBe("훈련탑");
  });
  it("런타임 이미지와 알 수 없는 속성을 지문/저장 대상에서 제거한다", () => {
    const input = { ...draftFixture(), secret: "ignored", doc: { ...draftFixture().doc, imageData: "data:image/png;base64,abc" } };
    expect(generationDraftFingerprint(input as GenerationDraftSnapshot)).not.toMatch(/imageData|secret|base64/);
  });
  it("잘못된 키와 과도한 분량, 결과 없는 초안은 거절한다", () => {
    expect(generationDraftKeySchema.safeParse("material:0").success).toBe(false);
    expect(generationDraftKeySchema.safeParse("job:../../../secret").success).toBe(false);
    expect(generationDraftSnapshotSchema.safeParse({ ...draftFixture(), doc: null }).success).toBe(false);
    const draft = draftFixture(); draft.doc!.sections[0].content = "가".repeat(20_001);
    expect(generationDraftSnapshotSchema.safeParse(draft).success).toBe(false);
  });
  it("모든 분야의 동작 버튼은 흰 글자와 4.5:1 이상 대비를 갖는다", () => {
    const linear = (n: number) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    for (const category of ["산악", "수난", "화재", "구급", "일반구조", "화학사고", "드론 운용", "장비 관리", "복무·행정", "현장지휘·공통", "기타"]) {
      const rgb = categoryStyle(category).actionHex.slice(1).match(/../g)!.map((hex) => linear(parseInt(hex, 16) / 255));
      const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      expect(1.05 / (luminance + .05), category).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("연결된 원문은 해당 페이지를 새 창으로 열고 미연결 자료는 링크를 만들지 않는다", () => {
    const linked = renderToStaticMarkup(<GeneratedSourceLink source={{ document_id: 12, doc: "교범", page: 7 }} />);
    expect(linked).toContain('href="/docs/12?page=7"'); expect(linked).toContain('target="_blank"');
    const unlinked = renderToStaticMarkup(<GeneratedSourceLink source={{ document_id: 0, doc: "교범", page: 7 }} />);
    expect(unlinked).not.toContain("href="); expect(unlinked).toContain("원본 연결 대기");
  });
  it("미저장 완료 작업·실패 작업과 편집 초안에 재진입 링크를 제공한다", () => {
    const html = renderToStaticMarkup(<GenerationRecoveryList jobs={[
      { id: "complete", status: "completed", stage: "완료", topic: "완료된 주제", type: "plan", updatedAt: "2026-09-05" },
      { id: "attention", status: "needs_attention", stage: "보완", topic: "보완할 주제", type: "slides", updatedAt: "2026-09-05" },
    ]} drafts={[{ id: "draft", draftKey: "job:complete", title: "편집한 주제", kind: "plan", updatedAt: "2026-09-05" }]} />);
    expect(html).toContain("/generate?j=complete"); expect(html).toContain("/generate?j=attention"); expect(html).toContain("/generate?d=draft");
    expect(html).toContain("편집한 주제 초안 삭제");
  });
});
