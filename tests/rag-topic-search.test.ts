import { describe, expect, it, vi } from "vitest";

// 서버 로직만 단위 검증하므로 Next 빌드의 server-only 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

import {
  buildTopicSearchPlans,
  classifyTopicSubjectAffinity,
  interleaveUnique,
  MAX_KEYWORD_SEARCH_QUERIES,
  normalizeKnownOcrErrors,
} from "@/lib/rag-external";

describe("buildTopicSearchPlans", () => {
  it("복합 절차 질문을 전체 검색과 하위주제별 정밀 검색으로 나눈다", () => {
    const plans = buildTopicSearchPlans(
      "화학보호복 착용 전 점검·착의·탈의·오염통제와 이상 시 중단·보고"
    );

    expect(plans[0]).toMatchObject({ id: "recall", mode: "recall" });
    expect(plans[0].queries[0].split(" or ")).toHaveLength(8);
    expect(plans.map((plan) => plan.id)).toEqual([
      "recall",
      "precheck",
      "donning",
      "doffing",
      "decontamination",
      "emergency",
      "procedure-steps",
      "procedure-safety",
    ]);
    expect(plans.find((plan) => plan.id === "precheck")?.queries).toContain(
      "화학보호복 점검"
    );
    expect(plans.find((plan) => plan.id === "donning")?.queries).toContain(
      "화학보호복 착용"
    );
    expect(plans.find((plan) => plan.id === "doffing")?.queries).toEqual(
      expect.arrayContaining(["화학보호복 탈의", "화학보호복 달의"])
    );
    expect(plans.find((plan) => plan.id === "decontamination")?.queries).toContain(
      "화학보호복 제독"
    );
    expect(plans.find((plan) => plan.id === "precheck")).toMatchObject({
      subject: "화학보호복",
      facetTerms: expect.arrayContaining(["점검", "검사", "확인"]),
    });
    expect(plans.flatMap((plan) => plan.queries).length).toBeLessThanOrEqual(
      MAX_KEYWORD_SEARCH_QUERIES
    );
  });

  it("짧고 포괄적인 주제는 확장 키워드로 필요한 절차 검색을 보탠다", () => {
    const plans = buildTopicSearchPlans("화학보호복 관련", [
      "착용",
      "점검",
      "탈의",
      "제독",
    ]);

    expect(plans.map((plan) => plan.id)).toEqual(
      expect.arrayContaining(["precheck", "donning", "doffing", "decontamination"])
    );
    expect(plans.filter((plan) => plan.id !== "recall").every((plan) => !plan.protect)).toBe(
      true
    );
  });

  it("표준작전절차 질문은 전체 검색에 행동절차·안전 근거를 보탠다", () => {
    const plans = buildTopicSearchPlans("소방드론 표준작전절차");

    expect(plans).toHaveLength(3);
    expect(plans[0].mode).toBe("recall");
    expect(plans.map((plan) => plan.id)).toEqual([
      "recall",
      "procedure-steps",
      "procedure-safety",
    ]);
  });

  it("암모니아 누출 주제를 물질·보호·구역·차단·제독 근거로 확장한다", () => {
    const plans = buildTopicSearchPlans("암모니아 누출시 대응");
    const leakPlan = plans.find((plan) => plan.id === "leak-control");
    const queries = plans.flatMap((plan) => plan.queries);

    expect(leakPlan).toMatchObject({
      mode: "precise",
      subject: "암모니아",
      protect: true,
    });
    expect(plans.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([
        "chemical-identification",
        "chemical-ppe",
        "chemical-zoning",
        "chemical-control",
        "chemical-decontamination",
      ])
    );
    expect(queries).toEqual(
      expect.arrayContaining([
        "보호장비",
        "통제구역",
        "암모니아 누출 차단",
        "암모니아 중화",
        "암모니아 제독",
      ])
    );
    expect(plans.flatMap((plan) => plan.queries).length).toBeLessThanOrEqual(
      MAX_KEYWORD_SEARCH_QUERIES
    );
  });

  it("인명구조사 2급의 등급을 보존하고 평가 세부 근거를 분리 검색한다", () => {
    const plans = buildTopicSearchPlans("인명구조사 2급 관련 정보?");

    expect(plans.every((plan) => plan.subject === "인명구조사 2급")).toBe(true);
    expect(plans.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([
        "qualification-items",
        "qualification-process",
        "qualification-equipment",
        "qualification-scoring",
      ])
    );
    expect(plans.find((plan) => plan.id === "qualification-items")?.queries).toEqual(
      expect.arrayContaining(["인명구조사 2급 평가 항목", "인명구조사 2급 평가 종목"])
    );
    expect(plans.find((plan) => plan.id === "qualification-equipment")?.queries).toContain(
      "인명구조사 2급 준비물"
    );
    expect(plans.find((plan) => plan.id === "qualification-scoring")?.queries).toEqual(
      expect.arrayContaining(["인명구조사 2급 감점", "인명구조사 2급 실격"])
    );
  });

  it.each([
    [
      "화학보호복을 입기 전에 대원이 점검해야 할 항목을 순서대로 알려줘",
      "화학보호복",
    ],
    [
      "화학사고 현장의 Hot·Warm·Cold Zone은 어떤 기준으로 설정하고 운영해야 해?",
      "화학사고",
    ],
    [
      "소방드론 비행 전 기체와 배터리, 현장 환경 점검 항목을 알려줘",
      "소방드론",
    ],
    ["화학사고의 Hot Zone 설정 기준", "화학사고"],
    ["공기 호흡기 착용 전 점검", "공기"],
    ["신규대원인데 화학보호복 착용 절차를 알려줘", "화학보호복"],
    ["저는 구조대원입니다. 화학보호복 착용 절차를 알려주세요", "화학보호복"],
    ["그럼 인명구조사 1급은?", "인명구조사 1급"],
    ["혹시 소방드론 비행 전 점검을 설명해주세요", "소방드론"],
  ])("자기소개·요청 표현을 제외한 핵심어를 subject로 보존한다: %s", (query, expectedSubject) => {
    const plans = buildTopicSearchPlans(query);

    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.subject === expectedSubject)).toBe(true);
  });

  it("모델 확장어에 다른 장비가 있어도 사용자가 명시한 주제를 바꾸지 않는다", () => {
    const plans = buildTopicSearchPlans("신규대원인데 화학보호복 착용 절차를 알려줘", ["소방드론", "비행", "배터리"]);
    expect(plans.every((plan) => plan.subject === "화학보호복")).toBe(true);
    expect(classifyTopicSubjectAffinity(plans[0].subject, ["점검"], "소방드론 점검", "소방드론 배터리를 점검한다."))
      .toBe("D");
  });

  it("모든 공통 절차가 포함돼도 실제 키워드 요청 수를 상한 이하로 제한한다", () => {
    const plans = buildTopicSearchPlans(
      "화학보호복 등급 선택과 착용 전 점검·착의·탈의·오염통제 및 이상 시 중단·보고"
    );

    expect(plans.flatMap((plan) => plan.queries)).toHaveLength(
      MAX_KEYWORD_SEARCH_QUERIES
    );
  });

  it("일반 장비의 장착·해체·세척을 보호복 절차로 잘못 분류하지 않는다", () => {
    expect(buildTopicSearchPlans("펌프 장착").map((plan) => plan.id)).not.toContain(
      "donning"
    );
    expect(buildTopicSearchPlans("로프 시스템 해체").map((plan) => plan.id)).not.toContain(
      "doffing"
    );
    expect(buildTopicSearchPlans("장비 세척").map((plan) => plan.id)).not.toContain(
      "decontamination"
    );
  });
});

describe("classifyTopicSubjectAffinity", () => {
  it("제목의 주제 일치와 제목 절차 + 본문 주제 일치를 A/B로 구분한다", () => {
    expect(
      classifyTopicSubjectAffinity(
        "공기호흡기",
        ["점검", "검사", "확인"],
        "공기호흡기 착용 전 점검",
        "용기 압력과 면체 기밀을 확인하는 현장 절차를 충분히 설명한다."
      )
    ).toBe("A");
    expect(
      classifyTopicSubjectAffinity(
        "공기호흡기",
        ["점검", "검사", "확인"],
        "착용 전 점검",
        "공기호흡기의 용기 압력과 면체 기밀을 확인한 뒤 착용한다."
      )
    ).toBe("B");
    expect(
      classifyTopicSubjectAffinity(
        "공기호흡기",
        ["탈의"],
        "공기호흡기 점검",
        "용기 압력과 면체 기밀을 확인하는 현장 절차를 충분히 설명한다."
      )
    ).toBe("D");
  });

  it("다른 주제 제목 아래 본문만 일치한 행은 C fallback, 주제도 약하면 D로 둔다", () => {
    expect(
      classifyTopicSubjectAffinity(
        "고층구조",
        ["점검", "확인"],
        "공기호흡기 관리",
        "고층구조 진입 전 로프와 확보 지점을 점검하고 통신 상태를 확인한다."
      )
    ).toBe("C");
    expect(
      classifyTopicSubjectAffinity(
        "공기호흡기",
        ["점검", "확인"],
        "고층구조 활동",
        "진입 전 로프와 확보 지점을 점검하고 통신 상태를 확인한다."
      )
    ).toBe("D");
    expect(
      classifyTopicSubjectAffinity(
        "소방드론",
        ["점검", "확인"],
        "비행 전 점검",
        "드론 기체와 배터리, 프로펠러 및 기상 상태를 확인한다."
      )
    ).toBe("B");
  });

  it("준비물 같은 일반 제목은 본문 근거가 있으면 C로 살리고 일반·짧은 주제는 기존 동작을 쓴다", () => {
    expect(
      classifyTopicSubjectAffinity(
        "공기호흡기",
        ["점검", "확인"],
        "준비물",
        "공기호흡기 용기 압력과 면체 상태를 점검하고 기록한다."
      )
    ).toBe("C");
    expect(classifyTopicSubjectAffinity("", ["점검"], "점검", "본문")).toBe("legacy");
    expect(classifyTopicSubjectAffinity("장비", ["점검"], "점검", "본문")).toBe(
      "legacy"
    );
    expect(classifyTopicSubjectAffinity("고층", ["점검"], "점검", "본문")).toBe(
      "legacy"
    );
  });

  it("정확한 문서명이 주제를 담으면 일반 Page 헤더도 해당 문서 근거로 인정한다", () => {
    expect(
      classifyTopicSubjectAffinity(
        "인명구조사 2급",
        ["준비물", "장비"],
        "Page 6",
        "평가에 필요한 준비물과 장비를 확인한다.",
        "2022년 인명구조사 2급 실기평가표.pdf"
      )
    ).toBe("A");
  });
});

describe("interleaveUnique", () => {
  it("하위질의마다 첫 결과를 보존하고 id 중복을 제거한다", () => {
    const lists = [
      [
        { id: "check-1" },
        { id: "shared" },
        { id: "check-2" },
      ],
      [
        { id: "doff-1" },
        { id: "shared" },
        { id: "doff-2" },
      ],
      [{ id: "decon-1" }],
    ];

    expect(interleaveUnique(lists, 6, (item) => item.id).map((item) => item.id)).toEqual([
      "check-1",
      "doff-1",
      "decon-1",
      "shared",
      "doff-2",
      "check-2",
    ]);
  });

  it("입력 배열을 바꾸지 않고 0 이하 제한을 안전하게 처리한다", () => {
    const lists = [[{ id: "a" }], [{ id: "b" }]];
    const snapshot = structuredClone(lists);

    expect(interleaveUnique(lists, 0, (item) => item.id)).toEqual([]);
    expect(interleaveUnique(lists, -1, (item) => item.id)).toEqual([]);
    expect(lists).toEqual(snapshot);
  });
});

describe("normalizeKnownOcrErrors", () => {
  it("검색 근거에서 반복 확인된 절차 OCR 오인식을 바로잡는다", () => {
    expect(
      normalizeKnownOcrErrors(
        "2인 7조로 보호복 달의 후 인체사위와 오염도 축정을 실시하고 지위관에게 보고"
      )
    ).toBe("2인 1조로 보호복 탈의 후 인체샤워와 오염도 측정을 실시하고 지휘관에게 보고");
  });

  it("정상 문장의 달의·7조·위원회 표현은 바꾸지 않는다", () => {
    const normal =
      "이번 달의 2인 7조 훈련과 사고조사위원회 운영 결과를 전달하고, 2인 7조로 보호복을 점검하며 사회적 지위관리를 논의한다.";

    expect(normalizeKnownOcrErrors(normal)).toBe(normal);
    expect(normalizeKnownOcrErrors(normal, "화학보호복 교육")).toBe(normal);
  });
});
