import { describe, expect, it } from "vitest";
import {
  MAX_FOCUSED_TRAINING_QUERY_CHARS,
  MAX_TRAINING_FOCUS_OPTIONS,
  TRAINING_FOCUS_CONCEPT_OVERLAP_THRESHOLD,
  TRAINING_FOCUS_SIMILARITY_THRESHOLD,
  buildFocusedTrainingQuery,
  buildTrainingFocusSuggestionPrompt,
  extractTrainingFocusEvidenceBySource,
  filterGroundedTrainingFocusOptions,
  isLikelyBroadTrainingTopic,
  normalizeTrainingFocusText,
  trainingFocusConceptOverlap,
  trainingFocusSimilarity,
  trainingFocusSuggestionsSchema,
} from "@/lib/generate-focus";

const SOURCE_A = "[산악구조 교육교범 p.12]";
const SOURCE_B = "[산악사고 대응절차 p.7]";

function candidate(title: string, sourceRefs: string[] = [SOURCE_A]) {
  return {
    title,
    description: `${title} 상황에서 대원의 역할과 핵심 수행을 반복 실습합니다.`,
    sourceRefs,
  };
}

describe("isLikelyBroadTrainingTopic", () => {
  it("세부 수행이 정해지지 않은 넓은 훈련 주제를 판별한다", () => {
    expect(isLikelyBroadTrainingTopic("산악사고대비 훈련")).toBe(true);
    expect(isLikelyBroadTrainingTopic("수난사고 종합 대응훈련")).toBe(true);
    expect(isLikelyBroadTrainingTopic("소방드론 훈련")).toBe(true);
  });

  it.each([
    "공기호흡기 착용 방법",
    "고립소방관 구조 절차",
    "급류구조 안전수칙",
    "산악 요구조자 야간 수색 훈련",
  ])("명시적인 방법·절차·수행이 있는 주제는 바로 생성할 수 있다: %s", (topic) => {
    expect(isLikelyBroadTrainingTopic(topic)).toBe(false);
  });

  it("빈 값이나 지나치게 짧은 값은 넓은 훈련 주제로 간주하지 않는다", () => {
    expect(isLikelyBroadTrainingTopic(" ")).toBe(false);
    expect(isLikelyBroadTrainingTopic("산")).toBe(false);
  });
});

describe("훈련 방향 문자열 정규화와 유사도", () => {
  it("NFKC를 적용하고 기호·연속 공백을 같은 단어 경계로 정규화한다", () => {
    expect(normalizeTrainingFocusText("  야간－산악   수색!!훈련  ")).toBe(
      "야간 산악 수색 훈련"
    );
    expect(normalizeTrainingFocusText("ＡＢＣ 구조")).toBe("abc 구조");
  });

  it("표현 차이가 작은 제목을 2-gram 기준으로 근접 중복으로 본다", () => {
    const score = trainingFocusSimilarity(
      "야간 산악 실종자 수색 및 위치 확인",
      "야간 산악 실종자 수색과 위치 확인"
    );

    expect(score).toBeGreaterThanOrEqual(TRAINING_FOCUS_SIMILARITY_THRESHOLD);
    expect(
      trainingFocusSimilarity("급경사지 들것 인양과 확보", "산악구조 통신망 운용 및 지휘")
    ).toBeLessThan(TRAINING_FOCUS_SIMILARITY_THRESHOLD);
  });

  it("어순과 일부 표현이 달라도 핵심 수행 개념이 겹치면 근접 중복으로 본다", () => {
    const score = trainingFocusConceptOverlap(
      "조난자 수색구역 설정과 위치 확인",
      "수색구역 분할 및 조난자 위치 확인"
    );

    expect(score).toBeGreaterThanOrEqual(TRAINING_FOCUS_CONCEPT_OVERLAP_THRESHOLD);
  });
});

describe("buildFocusedTrainingQuery", () => {
  it("세부 방향을 우선하면서 상위 주제를 함께 검색한다", () => {
    expect(
      buildFocusedTrainingQuery(
        "산악사고대비 훈련",
        "야간 실종자 수색과 위치 공유"
      )
    ).toBe("야간 실종자 수색과 위치 공유 / 상위 주제: 산악사고대비 훈련");
  });

  it("긴 값도 100자 이내에서 세부 방향과 상위 주제를 모두 보존한다", () => {
    const query = buildFocusedTrainingQuery("산악사고대비".repeat(20), "야간수색".repeat(30));

    expect(Array.from(query).length).toBeLessThanOrEqual(
      MAX_FOCUSED_TRAINING_QUERY_CHARS
    );
    expect(query).toContain("야간수색");
    expect(query).toContain("상위 주제:");
    expect(query).toContain("산악사고대비");
  });
});

describe("buildTrainingFocusSuggestionPrompt", () => {
  it("RAG 근거·정확한 출처·과거 중복 제외·부족 시 소수 반환을 명시한다", () => {
    const prompt = buildTrainingFocusSuggestionPrompt({
      category: "산악",
      topic: "산악사고대비 훈련",
      contextText: `${SOURCE_A}\n야간 수색 시 위치를 공유한다.`,
      allowedSourceRefs: [SOURCE_A, SOURCE_B, SOURCE_A],
      excludedFocuses: ["야간 산악 실종자 수색과 위치 확인"],
    });

    expect(prompt).toContain("분야: 산악");
    expect(prompt).toContain("상위 주제: 산악사고대비 훈련");
    expect(prompt).toContain("일반 상식이나 추측으로 내용을 보충하지 않습니다");
    expect(prompt).toContain("근거가 부족하면 0~3개만 반환");
    expect(prompt).toContain("철자와 공백까지 정확히 복사");
    expect(prompt).toContain("야간 산악 실종자 수색과 위치 확인");
    expect(prompt.match(/\[산악구조 교육교범 p\.12\]/g)).toHaveLength(2);
    expect(prompt).toContain("SOP·안전관리·역할 분담");
  });

  it("허용 출처가 없으면 옵션을 반환하지 말도록 지시한다", () => {
    const prompt = buildTrainingFocusSuggestionPrompt({
      category: "산악",
      topic: "산악사고대비 훈련",
      contextText: "",
      allowedSourceRefs: [],
    });

    expect(prompt).toContain("없음 (옵션을 반환하지 마세요)");
    expect(prompt).toContain("관련 참고 자료 없음");
  });
});

describe("filterGroundedTrainingFocusOptions", () => {
  it("허용 출처와 정확히 일치한 후보만 남기고 출처 중복은 정리한다", () => {
    const options = filterGroundedTrainingFocusOptions(
      [
        candidate("야간 실종자 수색과 위치 공유", [SOURCE_A, SOURCE_A, SOURCE_B]),
        candidate("급경사지 들것 인양", [`${SOURCE_A} `]),
        candidate("암벽 추락사고 접근", ["[만들어 낸 출처 p.1]"]),
      ],
      [SOURCE_A, SOURCE_B]
    );

    expect(options).toEqual([
      {
        id: "focus-1",
        ...candidate("야간 실종자 수색과 위치 공유", [SOURCE_A, SOURCE_B]),
      },
    ]);
  });

  it("후보끼리와 과거 방향의 2-gram 근접 중복을 제거한다", () => {
    const options = filterGroundedTrainingFocusOptions(
      [
        candidate("야간 산악 실종자 수색 및 위치 확인"),
        candidate("급경사지 들것 인양과 확보"),
        candidate("급경사지 들것 인양·확보"),
        candidate("산악구조 통신망 운용 및 지휘"),
      ],
      [SOURCE_A],
      ["야간 산악 실종자 수색과 위치 확인"]
    );

    expect(options.map((option) => option.title)).toEqual([
      "급경사지 들것 인양과 확보",
      "산악구조 통신망 운용 및 지휘",
    ]);
    expect(options.map((option) => option.id)).toEqual(["focus-1", "focus-2"]);
  });

  it("어순을 바꾼 유사 훈련도 과거 방향의 새 변형으로 다시 제시하지 않는다", () => {
    const options = filterGroundedTrainingFocusOptions(
      [candidate("수색구역 분할 및 조난자 위치 확인")],
      [SOURCE_A],
      ["조난자 수색구역 설정과 위치 확인"]
    );

    expect(options).toEqual([]);
  });

  it("실제 출처 라벨을 붙여도 본문과 의미 단서가 전혀 없으면 제외한다", () => {
    const context = `${SOURCE_A}\n야간 조난자 수색구역을 설정하고 위치정보를 공유한다.\n\n---\n\n${SOURCE_B}\n경사면에서 들것 결착과 로프 확보를 수행한다.`;
    const evidence = extractTrainingFocusEvidenceBySource(context);
    const options = filterGroundedTrainingFocusOptions(
      [
        candidate("야간 조난자 수색구역 설정", [SOURCE_A]),
        candidate("화학보호복 제독텐트 설치", [SOURCE_A]),
      ],
      [SOURCE_A, SOURCE_B],
      [],
      undefined,
      evidence
    );

    expect(options.map((option) => option.title)).toEqual(["야간 조난자 수색구역 설정"]);
  });

  it("분야 공통어 한 개만 겹치는 새 장비·상황 방향은 근거로 인정하지 않는다", () => {
    const context =
      "[산악 안전교육 p.3]\n산악 수색 대원은 위험요소를 확인하고 안전거리를 유지한다.";
    const options = filterGroundedTrainingFocusOptions(
      [
        candidate("산악 드론 열화상 수색", ["[산악 안전교육 p.3]"]),
      ],
      ["[산악 안전교육 p.3]"],
      [],
      undefined,
      extractTrainingFocusEvidenceBySource(context)
    );

    expect(options).toEqual([]);
  });

  it("공통 핵심어가 둘 이상이어도 출처에 없는 세부 장비를 섞은 방향은 제외한다", () => {
    const context =
      "[드론 수색 교범 p.8]\n드론을 이용해 수색구역을 나누고 수색 대원의 위치를 공유한다.";
    const options = filterGroundedTrainingFocusOptions(
      [candidate("드론 열화상 수색", ["[드론 수색 교범 p.8]"])],
      ["[드론 수색 교범 p.8]"],
      [],
      undefined,
      extractTrainingFocusEvidenceBySource(context)
    );

    expect(options).toEqual([]);
  });

  it("최대 5개만 반환하고 근거·중복 필터 후 부족한 수를 억지로 채우지 않는다", () => {
    const sixDistinct = [
      "야간 조난자 위치 탐색",
      "급경사지 들것 인양",
      "암벽 추락사고 접근",
      "산악 통신 음영지역 지휘",
      "저체온 요구조자 응급처치",
      "헬기 연계 인계지점 운영",
    ].map((title) => candidate(title));
    expect(
      filterGroundedTrainingFocusOptions(sixDistinct, [SOURCE_A])
    ).toHaveLength(MAX_TRAINING_FOCUS_OPTIONS);

    const insufficient = filterGroundedTrainingFocusOptions(
      [
        candidate("야간 산악 실종자 수색 및 위치 확인"),
        candidate("야간 산악 실종자 수색과 위치 확인"),
        candidate("출처 없는 방향", ["[없는 출처]"]),
      ],
      [SOURCE_A],
      ["야간 산악 실종자 수색과 위치 확인"]
    );
    expect(insufficient).toEqual([]);
  });

  it("LLM 응답 스키마는 빈 배열과 최대 5개를 허용하지만 6개는 거부한다", () => {
    expect(trainingFocusSuggestionsSchema.parse({ options: [] })).toEqual({ options: [] });
    expect(() =>
      trainingFocusSuggestionsSchema.parse({
        options: Array.from({ length: 6 }, (_, index) => candidate(`방향 ${index + 1}`)),
      })
    ).toThrow();
  });
});
