import { describe, expect, it } from "vitest";

import type { TrainingFocusOption } from "@/lib/generate-focus";
import {
  isSameTrainingTopicFamily,
  prioritizeTrainingFocusOptions,
  selectTrainingTopicHistory,
  trainingTopicFamilyTerms,
  type StoredTrainingMaterialRow,
} from "@/lib/training-focus-history";

function row(overrides: Partial<StoredTrainingMaterialRow> = {}): StoredTrainingMaterialRow {
  return {
    id: 1,
    kind: "plan",
    category: "화학사고",
    topic: "암모니아 누출 대응",
    title: "암모니아 누출 대응 훈련계획",
    focus: "누출원 확인과 공급 차단",
    created_at: "2026-09-01T01:00:00.000Z",
    ...overrides,
  };
}

describe("훈련 주제 저장 이력", () => {
  it("누출시·누설·유출 표현을 같은 상위 주제로 정규화한다", () => {
    expect(trainingTopicFamilyTerms("암모니아 누출시 대응")).toEqual([
      "누출",
      "암모니아",
    ]);
    expect(isSameTrainingTopicFamily("암모니아 누출시 대응", "암모니아 누설 대응훈련")).toBe(
      true
    );
    expect(isSameTrainingTopicFamily("암모니아 누출 대응", "화학보호복 착용 훈련")).toBe(false);
  });

  it("같은 상위 주제의 실제 저장 자료만 최소 메타데이터로 반환한다", () => {
    const result = selectTrainingTopicHistory(
      [
        row(),
        row({ id: 2, kind: "slides", title: "암모니아 누설 대응 발표자료" }),
        row({ id: 3, topic: "화학보호복 착용 훈련", title: "화학보호복 교안" }),
        row({ id: 4, kind: "notebooklm", title: "구형 프롬프트" }),
      ],
      "암모니아 누출시 대응"
    );

    expect(result.comparisonFocuses).toEqual(["누출원 확인과 공급 차단"]);
    expect(result.similarMaterials.map((material) => material.id)).toEqual([1, 2]);
    expect(result.similarMaterials[0]).toEqual({
      id: 1,
      title: "암모니아 누출 대응 훈련계획",
      topic: "암모니아 누출 대응",
      focus: "누출원 확인과 공급 차단",
      kind: "plan",
      createdAt: "2026-09-01T01:00:00.000Z",
    });
  });

  it("저장 이력과 유사한 추천은 삭제하지 않고 뒤로 정렬한다", () => {
    const options: TrainingFocusOption[] = [
      {
        id: "focus-1",
        title: "누출원 확인과 공급 차단",
        description: "기존과 유사한 방향",
        sourceRefs: ["[교재 p.1]"],
      },
      {
        id: "focus-2",
        title: "가스 측정과 위험구역 설정",
        description: "다른 수행 단계",
        sourceRefs: ["[교재 p.2]"],
      },
    ];

    const ranked = prioritizeTrainingFocusOptions(options, ["누출원 확인과 공급 차단"]);

    expect(ranked.map((option) => option.id)).toEqual(["focus-2", "focus-1"]);
    expect(ranked.map((option) => option.historyOverlap)).toEqual(["low", "similar"]);
  });

  it("표현이 달라도 핵심 수행이 같은 저장 이력은 유사 항목으로 안내한다", () => {
    const options: TrainingFocusOption[] = [
      {
        id: "focus-1",
        title: "수색구역 분할 및 조난자 위치 확인",
        description: "수색구역을 나누고 조난자 위치를 확인합니다.",
        sourceRefs: ["[교재 p.1]"],
      },
      {
        id: "focus-2",
        title: "급경사 로프 접근과 확보",
        description: "급경사 접근 전 확보 지점을 확인합니다.",
        sourceRefs: ["[교재 p.2]"],
      },
    ];

    const ranked = prioritizeTrainingFocusOptions(options, [
      "조난자 수색구역 설정과 위치 확인",
    ]);

    expect(ranked.map((option) => option.id)).toEqual(["focus-2", "focus-1"]);
    expect(ranked.map((option) => option.historyOverlap)).toEqual(["low", "similar"]);
  });
});
