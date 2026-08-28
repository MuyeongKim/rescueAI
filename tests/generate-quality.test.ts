import { describe, expect, it } from "vitest";
import {
  LESSON_SECTIONS,
  TRAINING_PLAN_SECTIONS,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  buildGenerationRepairPrompt,
  generatedDocSchemaFor,
  generatedLessonSchema,
  generatedPlanSchema,
  generatedSlidesSchema,
  extractSourceLabels,
  inspectGeneratedLesson,
  inspectGeneratedPlan,
  inspectGeneratedSlides,
  type GenerateRequest,
  type GeneratedDocDraft,
  type GeneratedSlide,
  type GeneratedSlideDeckDraft,
} from "@/lib/generate";

function fill(prefix: string, minimum: number): string {
  let value = prefix;
  while (value.replace(/\s+/g, " ").trim().length < minimum) value += ` ${prefix}`;
  return value;
}

function validPlan(): GeneratedDocDraft {
  return {
    title: "화재 공기호흡기 점검 신임대원 1시간 훈련계획",
    sections: [
      {
        heading: "훈련목표",
        content: fill(
          "대원은 점검 순서를 설명하고 교관의 체크리스트에 따라 장비 상태를 빠짐없이 확인하여 기준에 맞게 수행한다.",
          60
        ),
      },
      {
        heading: "훈련내용",
        content:
          "[이론교육 · 10분] 교관은 각 점검 항목의 목적과 적용 조건을 설명하고 대원은 장비에서 해당 부위를 찾아 말한다. " +
          "[교관시범 · 10분] 교관은 정상 순서를 천천히 시범 보이며 각 동작의 확인 지점과 자주 놓치는 부분을 질문한다. " +
          "[반복실습 · 25분] 대원은 2인 1조로 역할을 바꾸어 순서를 반복하고 동료는 체크리스트에 따라 즉시 피드백한다. " +
          "[종합수행 · 15분] 대원은 처음부터 끝까지 독립 수행하고 교관은 누락된 동작을 기록한 뒤 다시 수행하게 한다. " +
          fill("각 단계는 설명, 수행, 즉시 피드백이 이어지도록 진행한다.", 80),
      },
      {
        heading: "필요장비",
        content: fill(
          "교육용 장비는 실습 인원별로 준비하고 사용 전 외관, 결합 상태, 작동 여부를 교관과 대원이 함께 점검한다.",
          55
        ),
      },
      {
        heading: "안전관리",
        content: fill(
          "교관은 위험 구역을 통제하고 보호장비 상태를 사전에 점검한다. 이상 징후나 장비 결함이 발견되면 훈련을 즉시 중단하고 안전담당자에게 보고한 뒤 원인이 해소된 경우에만 재개한다.",
          120
        ),
      },
      {
        heading: "훈련평가",
        content: fill(
          "교관은 체크리스트로 대원의 순서 준수와 각 확인 동작을 관찰한다. 모든 필수 동작을 누락 없이 정확히 수행하면 통과하며, 누락 항목은 강평 후 다시 시연하여 기준 충족 여부를 확인한다.",
          110
        ),
      },
    ],
  };
}

function timedContent(minutes: number, text: string, minimum: number): string {
  return `[시간: ${minutes}분] ${fill(text, minimum)}`;
}

function validLesson(): GeneratedDocDraft {
  return {
    title: "화재 공기호흡기 점검 신임대원 1시간 실습 교안",
    sections: [
      {
        heading: "학습목표",
        content: fill(
          "교육 후 대원은 점검 목적을 설명하고, 제시된 순서에 따라 장비를 점검하며, 이상 상태를 발견해 보고할 수 있다.",
          85
        ),
      },
      {
        heading: "도입",
        content: timedContent(
          5,
          "교관은 장비 이상을 발견하지 못한 현장 상황을 제시하고 무엇을 먼저 확인해야 하는지 질문한다. 대원의 답을 오늘 배울 점검 순서와 연결해 학습 필요성을 설명한다.",
          130
        ),
      },
      {
        heading: "핵심이론",
        content: timedContent(
          15,
          "교관은 각 점검 단계의 목적, 적용 조건, 정상 상태와 이상 상태의 차이를 대상 수준에 맞는 말로 설명한다. 각 단계가 다음 단계와 어떻게 이어지는지 설명하고 핵심 용어는 처음 사용할 때 뜻을 풀어 준다.",
          280
        ),
      },
      {
        heading: "교관시범",
        content: timedContent(
          10,
          "교관은 장비를 정면에서 보여 주며 점검 동작을 순서대로 시범한다. 동작마다 손의 위치와 확인할 표시를 짚고 대원에게 지금 확인한 항목을 말하게 한다. 흔히 놓치는 지점에서는 동작을 멈추고 정상과 이상을 비교한다.",
          220
        ),
      },
      {
        heading: "대원실습",
        content: timedContent(
          20,
          "대원은 2인 1조로 수행자와 관찰자 역할을 번갈아 맡는다. 수행자는 순서를 말하며 점검하고 관찰자는 체크리스트로 누락을 기록한다. 교관은 한 번에 한 가지 행동을 구체적으로 피드백하고 대원이 수정 동작을 다시 수행하게 한다.",
          220
        ),
      },
      {
        heading: "안전유의사항",
        content: timedContent(
          5,
          "교관은 실습 구역의 위험요소를 제거하고 보호장비와 장비 결합 상태를 사전 점검한다. 장비 이상이나 대원 상태 이상이 보이면 즉시 훈련을 중단하고 안전담당자에게 보고한 뒤 확인 전에는 재개하지 않는다.",
          135
        ),
      },
      {
        heading: "정리·평가",
        content: timedContent(
          5,
          "교관은 핵심 순서를 다시 질문하고 모범답안을 제시한다. 대원은 체크리스트 없이 전 과정을 시연하며 교관은 필수 동작의 누락 여부와 순서 정확성을 관찰한다. 모든 기준을 정확히 수행하면 통과하고 누락 시 강평 후 다시 평가한다.",
          195
        ),
      },
    ],
  };
}

function validSlide(index: number): GeneratedSlide {
  const isSafety = index === 8;
  const isSummary = index === 9;
  return {
    title: isSafety
      ? "이상이 보이면 즉시 훈련을 멈춥니다"
      : isSummary
        ? "마지막 확인 질문으로 수행 기준을 점검합니다"
        : `${index + 1}단계 확인이 다음 행동의 안전을 결정합니다`,
    bullets: isSafety
      ? [
          "장비와 대원 상태의 위험 징후를 시작 전과 실습 중 확인합니다",
          "이상이 발견되면 즉시 중단하고 안전담당자에게 보고합니다",
        ]
      : isSummary
        ? [
            "확인 질문으로 단계별 목적과 순서를 다시 설명하게 합니다",
            "체크리스트 수행 기준을 모두 충족하면 최종 통과로 평가합니다",
          ]
        : [
            `${index + 1}단계에서는 정상 표시와 결합 상태를 눈으로 직접 확인합니다`,
            `확인 결과를 동료에게 말하고 다음 ${index + 2}단계로 이동합니다`,
          ],
    notes: fill(
      `교관은 ${index + 1}단계의 목적부터 설명합니다. 장비에서 확인할 위치를 직접 가리키며 정상 상태를 보여 줍니다. 대원에게 확인 결과를 말하게 하여 이해 여부를 점검합니다. 자주 놓치는 행동을 질문하고 잘못된 경우 즉시 다시 시범합니다. 마지막에는 현장에서 이 확인이 필요한 이유를 연결해 설명합니다.`,
      165
    ),
    layout: isSafety ? "safety" : isSummary ? "summary" : index === 0 ? "objectives" : "concept",
    sourceRefs: ["[공기호흡기 교육교범 p.3]"],
  };
}

function validSlides(): GeneratedSlideDeckDraft {
  return {
    title: "공기호흡기 점검이 안전한 진입을 만듭니다",
    slides: Array.from({ length: 10 }, (_, index) => validSlide(index)),
  };
}

describe("유형별 생성 스키마", () => {
  it("훈련계획은 정확히 고정 5개 제목과 순서만 허용한다", () => {
    const plan = validPlan();
    expect(generatedPlanSchema.parse(plan).sections.map((section) => section.heading)).toEqual(
      TRAINING_PLAN_SECTIONS
    );
    expect(generatedDocSchemaFor("plan")).toBe(generatedPlanSchema);

    const wrong = structuredClone(plan);
    wrong.sections[0].heading = "훈련 개요";
    expect(() => generatedPlanSchema.parse(wrong)).toThrow();
    expect(() => generatedPlanSchema.parse({ ...plan, sections: [...plan.sections, plan.sections[0]] })).toThrow();
  });

  it("교안은 실습형 7개 교육 흐름을 고정한다", () => {
    const lesson = validLesson();
    expect(generatedLessonSchema.parse(lesson).sections.map((section) => section.heading)).toEqual(
      LESSON_SECTIONS
    );
    expect(generatedDocSchemaFor("lesson")).toBe(generatedLessonSchema);
    expect(() => generatedLessonSchema.parse({ ...lesson, sections: lesson.sections.slice(0, 6) })).toThrow();
  });

  it("슬라이드는 의미 레이아웃과 장별 출처를 받을 수 있다", () => {
    expect(generatedSlidesSchema.parse(validSlides()).slides[0]).toMatchObject({
      layout: "objectives",
      sourceRefs: ["[공기호흡기 교육교범 p.3]"],
    });
    const invalid = validSlides();
    invalid.slides[0] = { ...invalid.slides[0], layout: "poster" as GeneratedSlide["layout"] };
    expect(() => generatedSlidesSchema.parse(invalid)).toThrow();
  });
});

describe("생성 프롬프트 품질 계약", () => {
  const base: Omit<GenerateRequest, "type"> = {
    category: "화재",
    audience: "신임 대원",
    duration: "1시간",
    topic: "공기호흡기 점검",
  };

  it("시스템 프롬프트는 풍부함보다 근거를 우선하고 대상별 깊이를 조정한다", () => {
    const prompt = buildGenerateSystemPrompt("화재", "[교범 p.3]\n근거 본문");
    expect(prompt).toContain("참고 자료에서 확인되지 않습니다");
    expect(prompt).toContain("출처 라벨");
    expect(prompt).toContain("분량을 늘리기 위해 추측하지 않습니다");
    expect(prompt).toContain("신임 대원은 용어를 처음 등장할 때");
  });

  it("훈련계획은 고정 제목·시간표·행동형 평가를 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "plan" });
    expect(prompt).toContain("정확히 이 제목으로, 이 순서대로");
    expect(prompt).toContain("[이론교육 · 20분]");
    expect(prompt).toContain("교관 행동, 대원 행동, 피드백 방법");
    expect(prompt).toContain("관찰 가능한 수행 기준");
  });

  it("교안은 도입→이론→시범→실습→안전→평가와 모범답안을 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "lesson" });
    for (const heading of LESSON_SECTIONS) expect(prompt).toContain(heading);
    expect(prompt).toContain("[시간: 00분]");
    expect(prompt).toContain("확인 질문과 모범답안");
    expect(prompt).toContain("교관이 별도 내용을 보충하지 않아도");
  });

  it("슬라이드는 서술형 제목·충분한 노트·의미 레이아웃·장별 출처를 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "slides" });
    expect(prompt).toContain("기억할 결론이 드러나는 서술형 문장");
    expect(prompt).toContain("발표자 노트는 4~7문장");
    expect(prompt).toContain("layout을 지정");
    expect(prompt).toContain("sourceRefs");
    expect(prompt).toContain("없는 출처를 만들지 마세요");
  });

  it("시스템 컨텍스트에서 실제 출처 라벨만 추출한다", () => {
    expect(
      extractSourceLabels(
        "[공기호흡기 교육교범 p.3]\n본문\n\n---\n\n[안전관리 지침 p.8]\n본문"
      )
    ).toEqual(["[공기호흡기 교육교범 p.3]", "[안전관리 지침 p.8]"]);
  });
});

describe("결정론적 생성 품질 검사", () => {
  it("충분한 훈련계획은 통과한다", () => {
    expect(inspectGeneratedPlan(validPlan(), "1시간")).toEqual({ ok: true, issues: [] });
  });

  it("출처 제목의 제한시간은 훈련 단계 시간 합계에 포함하지 않는다", () => {
    const plan = validPlan();
    plan.sections[1].content +=
      " [화학사고 대응능력 교재 — A급 착용 (제한시간 5분) p.260] [교재 — 제한시간 5분] [교재: 5분] [출처 · 5분]";

    expect(inspectGeneratedPlan(plan, "1시간")).toEqual({ ok: true, issues: [] });
  });

  it("단계 시간 뒤 반복 안내가 있어도 유효한 시간 표지로 계산한다", () => {
    const plan = validPlan();
    plan.sections[1].content = plan.sections[1].content.replace(
      "[종합수행 · 15분]",
      "[교재 활용 · 15분 / 반복]"
    );

    expect(inspectGeneratedPlan(plan, "1시간")).toEqual({ ok: true, issues: [] });
  });

  it("계획서의 누락·얇은 내용·시간·안전·평가 문제를 모두 보고한다", () => {
    const plan = validPlan();
    plan.sections = [
      { heading: "훈련목표", content: "목표" },
      { heading: "훈련내용", content: "[실습 · 10분] 짧은 실습" },
      { heading: "필요장비", content: "장비" },
      { heading: "안전관리", content: "조심한다." },
      { heading: "기타", content: "불필요" },
    ];
    const codes = inspectGeneratedPlan(plan, "1시간").issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "missing_section",
        "unexpected_section",
        "thin_content",
        "time_total_mismatch",
        "missing_safety",
      ])
    );
  });

  it("충분한 교안은 통과하고 시간표 오류는 잡는다", () => {
    const lesson = validLesson();
    expect(inspectGeneratedLesson(lesson, "1시간")).toEqual({ ok: true, issues: [] });
    lesson.sections[1].content = lesson.sections[1].content.replace("5분", "10분");
    expect(inspectGeneratedLesson(lesson, "1시간").issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "time_total_mismatch" })])
    );
  });

  it("슬라이드 수·노트·중복·레이아웃·출처·안전·평가 문제를 잡는다", () => {
    const deck: GeneratedSlideDeckDraft = {
      title: "미완성",
      slides: Array.from({ length: 6 }, () => ({
        title: "핵심 요약",
        bullets: ["짧음"],
        notes: "짧은 노트",
      })),
    };
    const codes = inspectGeneratedSlides(deck, "1시간").issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "slide_count",
        "thin_content",
        "thin_notes",
        "duplicate_slide_title",
        "duplicate_slide_content",
        "missing_slide_layout",
        "generic_slide_title",
        "missing_source_refs",
        "missing_safety",
        "missing_evaluation",
      ])
    );
  });

  it("충분한 1시간 슬라이드 덱은 통과한다", () => {
    expect(inspectGeneratedSlides(validSlides(), "1시간")).toEqual({ ok: true, issues: [] });
  });

  it("실제 참고 자료에 없는 문서 출처를 품질 문제로 잡는다", () => {
    const allowed = ["[공기호흡기 교육교범 p.3]"];
    const deck = validSlides();
    deck.slides[0].sourceRefs = ["[만들어낸 교범 p.99]"];
    expect(inspectGeneratedSlides(deck, "1시간", allowed).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_source_ref" })])
    );

    const plan = validPlan();
    expect(inspectGeneratedPlan(plan, "1시간", allowed).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_source_citation" })])
    );
  });
});

describe("자동 보완 프롬프트", () => {
  it("품질 이슈와 원본 초안, 고정 구조, 환각 금지 규칙을 함께 전달한다", () => {
    const draft = validPlan();
    draft.sections[0].content = "짧음";
    const quality = inspectGeneratedPlan(draft, "1시간");
    const prompt = buildGenerationRepairPrompt({
      type: "plan",
      request: {
        category: "화재",
        audience: "신임 대원",
        duration: "1시간",
        topic: "공기호흡기 점검",
      },
      draft,
      report: quality,
    });

    expect(prompt).toContain("[thin_content]");
    expect(prompt).toContain(TRAINING_PLAN_SECTIONS.join(" → "));
    expect(prompt).toContain(JSON.stringify(draft, null, 2));
    expect(prompt).toContain("일반 상식·수치·절차·사례를 만들지 마세요");
    expect(prompt).toContain("전체 JSON 객체만 반환");
  });

  it("통과한 결과에는 불필요한 보완 호출을 만들지 않는다", () => {
    expect(() =>
      buildGenerationRepairPrompt({
        type: "plan",
        request: { category: "화재", audience: "신임 대원", duration: "1시간" },
        draft: validPlan(),
        report: { ok: true, issues: [] },
      })
    ).toThrow("수정할 품질 문제가 없습니다.");
  });
});
