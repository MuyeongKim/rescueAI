import { describe, expect, it } from "vitest";
import {
  LESSON_SECTIONS,
  GENERATION_QUALITY_LABELS,
  MAX_GENERATION_CONDITIONS_CHARS,
  MAX_SLIDE_BULLET_CHARS,
  MAX_SLIDE_STEP_CHARS,
  MAX_SLIDE_TITLE_CHARS,
  RECOMMENDED_SLIDE_DECK_MODE,
  TRAINING_PLAN_SECTIONS,
  bindSlideVisualsToSources,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  buildGenerationRepairPrompt,
  buildSectionRegenPrompt,
  buildSlideRegenPrompt,
  generatedDocSchemaFor,
  generatedLessonSchema,
  generatedPlanSchema,
  generatedSlideSchema,
  generatedSlidesSchema,
  extractSourceLabels,
  generationQualityMessages,
  generationQualityWarnings,
  inspectCurrentGenerationQuality,
  inspectGeneratedLesson,
  inspectGeneratedPlan,
  inspectGeneratedSlides,
  selectGenerationContextBySourceRefs,
  splitGeneratedSourcesForDisplay,
  stripDocumentInlineSourceRefs,
  stripDocumentInlineSourceRefsFromText,
  stripSectionInlineSourceRefs,
  strictGeneratedSlideSchemaFor,
  strictGeneratedSlidesSchemaFor,
  type GenerateRequest,
  type GeneratedDocDraft,
  type GeneratedSlide,
  type GeneratedSlideDeckDraft,
} from "@/lib/generate";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
} from "@/lib/sop-evidence";

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
          "[교관시범 · 10분] 교관은 정상 순서를 천천히 시범 보이며 각 동작의 확인 지점과 자주 놓치는 부분을 질문한다.\n" +
          "[반복실습 · 25분] 대원 행동절차:\n" +
          "1) 장비 외관을 눈으로 점검하고 손상 여부를 확인한다.\n" +
          "2) 결합부를 손으로 당겨 고정 상태를 확인하고 동료에게 결과를 말한다.\n" +
          "3) 작동 상태를 확인한 뒤 수행 결과를 교관에게 보고하고 역할을 교대한다.\n" +
          "이상 시: 수행을 즉시 중단하고 교관에게 보고한 뒤 해당 항목을 교정하여 다시 점검한다. 동료는 체크리스트에 따라 즉시 피드백한다. " +
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
          "대원은 2인 1조로 수행자와 관찰자 역할을 번갈아 맡는다. 대원 행동절차:\n1) 장비 외관을 점검하고 손상 여부를 확인한다.\n2) 결합부를 손으로 당겨 고정 상태를 확인하고 결과를 복창한다.\n3) 작동 상태를 확인한 뒤 관찰자와 교관에게 결과를 보고하고 역할을 교대한다.\n이상 시: 수행을 즉시 중단하고 교관에게 보고한 뒤 누락 동작을 교정하여 다시 점검한다. 관찰자는 체크리스트로 누락을 기록하고 교관은 한 번에 한 가지 행동을 구체적으로 피드백한다.",
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

function citeSections(
  draft: GeneratedDocDraft,
  headings: readonly string[],
  sourceRef: string
): GeneratedDocDraft {
  const cited = structuredClone(draft);
  cited.sections.forEach((section) => {
    if (headings.includes(section.heading)) section.content += ` ${sourceRef}`;
  });
  return cited;
}

function validSlide(index: number): GeneratedSlide {
  const isSafety = index === 8;
  const isSummary = index === 9;
  const roles: NonNullable<GeneratedSlide["role"]>[] = [
    "objectives",
    "concept",
    "equipment",
    "procedure",
    "timeline",
    "decision",
    "case",
    "procedure",
    "safety",
    "summary",
  ];
  const compositions: NonNullable<GeneratedSlide["composition"]>[] = [
    "list",
    "statement",
    "checklist",
    "process",
    "timeline",
    "decision-flow",
    "scenario",
    "process",
    "checklist",
    "summary",
  ];
  const stepCompositions = new Set(["process", "timeline", "decision-flow"]);
  const composition = compositions[index];
  return {
    title: isSafety
      ? "이상이 보이면 즉시 훈련을 멈춥니다"
      : isSummary
        ? "마지막 확인 질문으로 수행 기준을 점검합니다"
        : index === 6
          ? "현장 상황에서 첫 조치를 판단합니다"
          : index === 7
            ? "직접 수행하고 동료 피드백을 받습니다"
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
        : index === 6
          ? [
              "출동 현장 상황과 장비 상태를 읽고 가장 먼저 할 조치를 선택합니다",
              "선택한 판단 근거를 동료에게 설명하고 다음 대응을 결정합니다",
            ]
          : index === 7
            ? [
                "대원은 2인 1조로 점검 순서를 직접 수행하고 역할을 교대합니다",
                "동료는 수행 과정을 관찰하며 놓친 행동을 즉시 알려 줍니다",
                "이상이나 누락이 보이면 중단하고 교관에게 보고한 뒤 다시 수행합니다",
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
    role: roles[index],
    composition,
    steps: stepCompositions.has(composition)
      ? index === 7
        ? ["외관 점검", "결합 확인", "이상 보고"]
        : [`${index + 1}단계`, `${index + 2}단계`, `${index + 3}단계`]
      : undefined,
    visual: { mode: "none" },
    sourceRefs: ["[공기호흡기 교육교범 p.3]"],
  };
}

function validSlides(): GeneratedSlideDeckDraft {
  return {
    title: "공기호흡기 점검이 안전한 진입을 만듭니다",
    mode: "presenter",
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

  it("슬라이드는 교육 역할·화면 구도·시각자료 계획과 장별 출처를 받을 수 있다", () => {
    expect(RECOMMENDED_SLIDE_DECK_MODE).toBe("detailed");
    expect(generatedSlidesSchema.parse(validSlides()).slides[0]).toMatchObject({
      layout: "objectives",
      role: "objectives",
      composition: "list",
      visual: { mode: "none" },
      sourceRefs: ["[공기호흡기 교육교범 p.3]"],
    });
    const invalid = validSlides();
    invalid.slides[0] = { ...invalid.slides[0], layout: "poster" as GeneratedSlide["layout"] };
    expect(() => generatedSlidesSchema.parse(invalid)).toThrow();
  });

  it("신규 전체·부분 생성 스키마는 허용된 sourceRefs를 1~4개 반드시 요구한다", () => {
    const allowed = "[공기호흡기 교육교범 p.3]";
    const strictDeckSchema = strictGeneratedSlidesSchemaFor([allowed, allowed]);
    const strictSlideSchema = strictGeneratedSlideSchemaFor([allowed]);
    const valid = validSlides();

    expect(strictDeckSchema.parse(valid).slides[0].sourceRefs).toEqual([allowed]);
    expect(strictSlideSchema.parse(valid.slides[0]).sourceRefs).toEqual([allowed]);

    const missing = structuredClone(valid);
    delete missing.slides[0].sourceRefs;
    expect(generatedSlidesSchema.safeParse(missing).success).toBe(true);
    expect(strictDeckSchema.safeParse(missing).success).toBe(false);

    const invented = structuredClone(valid.slides[0]);
    invented.sourceRefs = ["[만들어낸 교범 p.99]"];
    expect(strictSlideSchema.safeParse(invented).success).toBe(false);

    const oversizedNotes = structuredClone(valid.slides[0]);
    oversizedNotes.notes = "가".repeat(5_001);
    expect(generatedSlideSchema.safeParse(oversizedNotes).success).toBe(true);
    expect(strictSlideSchema.safeParse(oversizedNotes).success).toBe(false);

    const oversizedBullet = structuredClone(valid.slides[0]);
    oversizedBullet.bullets = ["가".repeat(501), "정상 범위의 두 번째 핵심 문장입니다."];
    expect(strictSlideSchema.safeParse(oversizedBullet).success).toBe(false);
    expect(() => strictGeneratedSlidesSchemaFor([])).toThrow("검증된 출처 라벨이 없습니다");
    expect(() => strictGeneratedSlideSchemaFor([`[${"가".repeat(300)}]`])).toThrow(
      "검증된 출처 라벨이 없습니다"
    );
  });

  it("비교·흐름·원문 설명 구도를 구조화하고 런타임 이미지는 LLM 스키마에서 제외한다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "comparison",
      composition: "comparison",
      steps: ["정상", "이상"],
      visual: {
        mode: "source-page",
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "정상과 이상 상태를 나란히 보여 주는 교범 페이지",
        imageData: "data:image/png;base64,AAAA",
      },
    };

    const parsed = generatedSlidesSchema.parse(deck);
    expect(parsed.slides[1]).toMatchObject({
      role: "comparison",
      composition: "comparison",
      steps: ["정상", "이상"],
      visual: { mode: "source-page" },
    });
    expect(parsed.slides[1].visual).not.toHaveProperty("imageData");
  });
});

describe("SOP·표준절차 생성 계약 통합", () => {
  const sopLabel = "[공기호흡기 교육교범 p.3]";

  it("세 유형의 결정론 검사에 분리된 SOP 근거 계약을 함께 적용한다", () => {
    const plan = validPlan();
    plan.sections[1].content = `${SOP_APPLICATION_MARKER} 점검 순서를 적용한다. ${sopLabel}\n${plan.sections[1].content}`;
    const lesson = validLesson();
    lesson.sections[2].content = `${SOP_APPLICATION_MARKER} 점검 순서를 시범과 실습에 적용한다. ${sopLabel}\n${lesson.sections[2].content}`;
    const slides = validSlides();
    slides.slides[1].notes = `${SOP_APPLICATION_MARKER} 점검 순서를 적용합니다. ${slides.slides[1].notes}`;
    slides.slides[1].sourceRefs = [sopLabel];
    const evidence = { status: "found" as const, sourceLabels: [sopLabel] };

    expect(
      inspectGeneratedPlan(plan, "1시간", undefined, evidence).issues.filter((issue) =>
        issue.code.includes("sop")
      )
    ).toEqual([]);
    expect(
      inspectGeneratedLesson(lesson, "1시간", undefined, evidence).issues.filter((issue) =>
        issue.code.includes("sop")
      )
    ).toEqual([]);
    expect(
      inspectGeneratedSlides(slides, "1시간", [sopLabel], evidence).issues.filter((issue) =>
        issue.code.includes("sop")
      )
    ).toEqual([]);
  });

  it("SOP 근거가 없거나 검색 장애면 지정 위치에 상태별 정확한 안내문을 요구한다", () => {
    const plan = validPlan();
    const missing = inspectGeneratedPlan(plan, "1시간", undefined, {
      status: "not_found",
      sourceLabels: [],
    });
    expect(missing.issues.map((issue) => issue.code)).toContain("missing_sop_disclosure");

    plan.sections[1].content = `${SOP_NOT_FOUND_DISCLOSURE}\n${plan.sections[1].content}`;
    expect(
      inspectGeneratedPlan(plan, "1시간", undefined, {
        status: "not_found",
        sourceLabels: [],
      }).issues.map((issue) => issue.code)
    ).not.toContain("missing_sop_disclosure");

    const lesson = validLesson();
    lesson.sections[2].content = `${SOP_DEGRADED_DISCLOSURE}\n${lesson.sections[2].content}`;
    expect(
      inspectGeneratedLesson(lesson, "1시간", undefined, {
        status: "degraded",
        sourceLabels: [],
      }).issues.map((issue) => issue.code)
    ).not.toContain("missing_sop_disclosure");
  });

  it("프롬프트는 상위 주제와 선택 방향을 분리하고 SOP 고정 위치를 명시한다", () => {
    const request: GenerateRequest = {
      type: "plan",
      category: "산악",
      audience: "일반 대원",
      duration: "1시간",
      topic: "산악사고대비 훈련",
      focus: "야간 조난자 수색구역 설정",
    };
    const prompt = buildGeneratePrompt(request, {
      status: "not_found",
      sourceLabels: [],
    });
    const system = buildGenerateSystemPrompt("산악", "[산악 교범 p.1]\n근거", {
      status: "not_found",
      sourceLabels: [],
    });

    expect(prompt).toContain("상위 훈련 주제: 산악사고대비 훈련");
    expect(prompt).toContain("이번 세부 훈련 방향: 야간 조난자 수색구역 설정");
    expect(prompt).toContain(SOP_NOT_FOUND_DISCLOSURE);
    expect(system).toContain(SOP_NOT_FOUND_DISCLOSURE);
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
    expect(prompt).toContain("훈련계획·교안은 본문 문장 뒤에");
    expect(prompt).toContain("문서 맨 뒤의 '근거 자료 및 출처'");
    expect(prompt).toContain("슬라이드는 각 장의 sourceRefs에만");
    expect(prompt).toContain("기술 사실과 훈련 가정의 경계");
    expect(prompt).toContain('"훈련 가정:"');
    expect(prompt).toContain("상황 → 판단 조건 → 행동 → 확인 → 실수 교정 → 평가");
    expect(prompt).toContain("고정된 행동 순서가 있으면 그 순서를 보존");
  });

  it("훈련계획은 고정 제목·시간표·행동형 평가를 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "plan" });
    expect(prompt).toContain("정확히 이 제목으로, 이 순서대로");
    expect(prompt).toContain("[이론교육 · 20분]");
    expect(prompt).toContain("교관 행동, 대원 행동, 피드백 방법");
    expect(prompt).toContain("흔한 실수·교정");
    expect(prompt).toContain("최소 3개의 관찰 가능한 행동");
    expect(prompt).toContain("1) 동작 → 확인 지점");
    expect(prompt).toContain("이상 시:");
    expect(prompt).toContain("관찰 가능한 수행 기준");
    expect(prompt).toContain("미달 시 피드백·재수행");
    expect(prompt).toContain("핵심 대원 행동 단계와 같은 순서로 연결");
    expect(prompt).toContain("본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 붙이지 마세요");
  });

  it("교안은 도입→이론→시범→실습→안전→평가와 모범답안을 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "lesson" });
    for (const heading of LESSON_SECTIONS) expect(prompt).toContain(heading);
    expect(prompt).toContain("[시간: 00분]");
    expect(prompt).toContain("확인 질문과 모범답안");
    expect(prompt).toContain("교관이 별도 내용을 보충하지 않아도");
    expect(prompt).toContain("대원실습의 행동 단계와 같은 순서로 연결");
    expect(prompt).toContain("근거 자료 및 출처");
  });

  it("슬라이드는 서술형 제목·충분한 노트·의미 레이아웃·장별 출처를 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "slides" });
    expect(prompt).toContain("기억할 결론이 드러나는 서술형 문장");
    expect(prompt).toContain("발표자 노트는 4~7문장");
    expect(prompt).toContain("교육 역할 role과 화면 구도 composition");
    expect(prompt).toContain("원문 사진·표·도해");
    expect(prompt).toContain("source-page");
    expect(prompt).not.toContain("source-crop");
    expect(prompt).toContain("mode=presenter");
    expect(prompt).toContain("sourceRefs");
    expect(prompt).toContain("없는 출처를 만들지 마세요");
    expect(prompt).toContain("판단 조건, 우선 행동, 그 행동을 선택한 근거");
    expect(prompt).toContain("자주 생기는 실수와 즉시 교정·재수행 방법");
    expect(prompt).toContain("steps에 3~5개의 실제 대원 행동 핵심어");
    expect(prompt).toContain("이상 시 중단·보고");
    expect(prompt).toContain(`서술형 문장으로 쓰고 ${MAX_SLIDE_TITLE_CHARS}자`);
    expect(prompt).toContain(`각 문장은 ${MAX_SLIDE_BULLET_CHARS}자`);
    expect(prompt).toContain(`각 단계어는 ${MAX_SLIDE_STEP_CHARS}자`);
  });

  it("상세형은 혼자 읽을 수 있는 화면 밀도와 보충 노트를 요구한다", () => {
    const prompt = buildGeneratePrompt({ ...base, type: "slides", slideMode: "detailed" });
    expect(prompt).toContain("상세형 — 발표 없이 읽어도 이해되는 교육자료");
    expect(prompt).toContain('최상위 mode는 반드시 "detailed"');
    expect(prompt).toContain("화면 문장은 3~4개");
  });

  it("사용자가 입력한 현장 조건은 반영하고 입력하지 않은 수량은 추정하지 않는다", () => {
    const conditions = "참여 12명 / 교관 2명 / 공기호흡기 6세트 / 실내 훈련장";
    const withConditions = buildGeneratePrompt({
      ...base,
      type: "plan",
      conditions,
    });
    expect(withConditions).toContain(`현장 조건(사용자 입력): ${conditions}`);
    expect(withConditions).toContain("입력되지 않은 수량이나 조건을 추가로 추정하지 마세요");

    const withoutConditions = buildGeneratePrompt({ ...base, type: "lesson" });
    expect(withoutConditions).toContain("현장 조건: 입력되지 않음");
    expect(withoutConditions).toContain(
      "참여 인원·교관 수·조 편성 인원·장비 수량을 임의로 특정하지 마세요"
    );
  });

  it("현장 조건은 프롬프트에서도 최대 500자로 제한하고 줄바꿈을 정리한다", () => {
    const normalized = `실내 훈련장 ${"가".repeat(MAX_GENERATION_CONDITIONS_CHARS)}`;
    const prompt = buildGeneratePrompt({
      ...base,
      type: "slides",
      conditions: `  실내\n훈련장 ${"가".repeat(MAX_GENERATION_CONDITIONS_CHARS)}  `,
    });
    expect(prompt).toContain(
      `현장 조건(사용자 입력): ${normalized.slice(0, MAX_GENERATION_CONDITIONS_CHARS)}`
    );
    expect(prompt).not.toContain(normalized.slice(0, MAX_GENERATION_CONDITIONS_CHARS + 1));
  });

  it("부분 재생성에도 같은 현장 조건과 수량 추정 금지 규칙을 적용한다", () => {
    const sectionPrompt = buildSectionRegenPrompt({
      category: base.category,
      audience: base.audience,
      duration: base.duration,
      docTitle: "공기호흡기 교안",
      outline: ["학습목표", "대원실습"],
      index: 1,
      currentHeading: "대원실습",
      currentContent: "현재 내용",
      conditions: "대원 8명 / 공기호흡기 4세트",
    });
    expect(sectionPrompt).toContain("현장 조건(사용자 입력): 대원 8명 / 공기호흡기 4세트");
    expect(sectionPrompt).toContain("최소 3개의 번호 행동");
    expect(sectionPrompt).toContain("재점검·재수행");

    const slidePrompt = buildSlideRegenPrompt({
      category: base.category,
      audience: base.audience,
      duration: base.duration,
      deckTitle: "공기호흡기 발표",
      outline: ["점검 순서"],
      index: 0,
      current: validSlide(0),
    });
    expect(slidePrompt).toContain("현장 조건: 입력되지 않음");
    expect(slidePrompt).toContain("장비 수량을 임의로 특정하지 마세요");
    expect(slidePrompt).toContain("steps를 실제 대원 행동 3~5개");
    expect(slidePrompt).toContain("이상 시 중단·보고·재수행");
    expect(slidePrompt).toContain("source-page/native-diagram/none");
    expect(slidePrompt).not.toContain("source-crop");
  });

  it("시스템 컨텍스트에서 실제 출처 라벨만 추출한다", () => {
    expect(
      extractSourceLabels(
        "[공기호흡기 교육교범 p.3]\n본문\n\n---\n\n[안전관리 지침 p.8]\n본문"
      )
    ).toEqual(["[공기호흡기 교육교범 p.3]", "[안전관리 지침 p.8]"]);
  });

  it("구성안이 고른 출처 청크만 다음 작성 단계에 전달한다", () => {
    const context =
      "[교범 A p.1]\nA 전용 내용\n\n---\n\n" +
      "[교범 B p.2]\nB 전용 내용\n\n---\n\n" +
      "=== 관련 SOP ===\n[SOP p.3]\nSOP 전용 내용";

    const selected = selectGenerationContextBySourceRefs(context, ["[교범 B p.2]"]);
    expect(selected).toContain("B 전용 내용");
    expect(selected).not.toContain("A 전용 내용");
    expect(selected).not.toContain("SOP 전용 내용");
    expect(selectGenerationContextBySourceRefs(context, [])).toBe(context);
    expect(selectGenerationContextBySourceRefs(context, ["[없는 자료 p.9]"])).toBe(context);
  });
});

describe("원문 시각자료 출처 바인딩", () => {
  it("LLM의 ID는 버리고 정확히 일치하는 검색 출처의 문서·페이지를 연결한다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-page",
        documentId: 999,
        page: 999,
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "교범 원문 장비 점검 그림",
      },
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 17, doc: "공기호흡기 교육교범", page: 3 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({
      mode: "source-page",
      documentId: 17,
      page: 3,
      sourceRef: "[공기호흡기 교육교범 p.3]",
      fit: "contain",
    });
  });

  it("한글 조합 방식이 달라도 검증 출처를 연결하고 서버 원문 라벨로 정규화한다", () => {
    const deck = validSlides();
    const nfdTitle = "공기호흡기 교육교범".normalize("NFD");
    deck.slides[1] = {
      ...deck.slides[1],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-page",
        sourceRef: `[${nfdTitle.normalize("NFC")} p.3]`,
      },
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 17, doc: nfdTitle, page: 3 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({
      mode: "source-page",
      documentId: 17,
      page: 3,
      sourceRef: `[${nfdTitle} p.3]`,
    });
  });

  it("출처가 일치하지 않거나 원문 문서 ID가 없으면 외부 이미지를 요청하지 않는다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "timeline",
      composition: "timeline",
      steps: ["준비", "수행", "보고"],
      visual: {
        mode: "source-crop",
        documentId: 123,
        page: 7,
        sourceRef: "[만들어낸 교범 p.7]",
        altText: "검증되지 않은 그림",
      },
    };
    deck.slides[2] = {
      ...deck.slides[2],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-page",
        sourceRef: "[외부 자료 p.5]",
        altText: "연결할 수 없는 외부 자료",
      },
      sourceRefs: ["[외부 자료 p.5]"],
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 0, doc: "외부 자료", page: 5 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({ mode: "native-diagram" });
    expect(bound.slides[1].visual).not.toHaveProperty("documentId");
    expect(bound.slides[2].visual).toMatchObject({ mode: "none" });
  });

  it("visual.sourceRef 자체가 정확히 일치해야 하며 일반 본문 출처로 대신 연결하지 않는다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-page",
        altText: "결합부 위치를 보여 주는 원문 페이지",
      },
      sourceRefs: ["[공기호흡기 교육교범 p.3]"],
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 17, doc: "공기호흡기 교육교범", page: 3 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({ mode: "none" });
    expect(bound.slides[1].visual).not.toHaveProperty("documentId");
  });

  it("같은 출처 라벨이 서로 다른 문서 ID를 가리키면 모호한 원문을 연결하지 않는다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-page",
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "공기호흡기 원문 그림",
      },
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 17, doc: "공기호흡기 교육교범", page: 3 },
      { document_id: 18, doc: "공기호흡기 교육교범", page: 3 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({ mode: "none" });
  });

  it("원문 시각자료는 visual-explanation에서만 연결하고 과거 crop 요청은 전체 페이지로 정규화한다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      composition: "comparison",
      steps: ["정상", "이상"],
      visual: {
        mode: "source-page",
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "정상과 이상 상태",
      },
    };
    deck.slides[2] = {
      ...deck.slides[2],
      role: "evidence",
      composition: "visual-explanation",
      visual: {
        mode: "source-crop",
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "교범 원문 페이지",
      },
    };

    const bound = bindSlideVisualsToSources(deck, [
      { document_id: 17, doc: "공기호흡기 교육교범", page: 3 },
    ]);

    expect(bound.slides[1].visual).toMatchObject({ mode: "native-diagram" });
    expect(bound.slides[2].visual).toMatchObject({
      mode: "source-page",
      documentId: 17,
      page: 3,
    });
  });
});

describe("생성 출처 표시와 시각자료 바인딩 분리", () => {
  it("화면에는 5개만 표시하지만 바인딩에는 회수한 모든 고유 페이지를 유지한다", () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      document_id: index + 1,
      doc: `교범 ${index + 1}`,
      page: index + 1,
    }));

    const split = splitGeneratedSourcesForDisplay(candidates, 5);

    expect(split.sources).toHaveLength(5);
    expect(split.bindingSources).toHaveLength(7);
    expect(split.bindingSources[6]).toEqual({ document_id: 7, doc: "교범 7", page: 7 });
  });
});

describe("훈련계획·교안 본문과 출처 목록 분리", () => {
  const sourceA = "[로프구조 — 유형별 로프구조시스템 p.44]";
  const sourceB = "[로프구조 — 경사면 구조 p.47]";

  it("문장 뒤 출처는 제거하고 시간·SOP 제어 표식은 보존한다", () => {
    const content =
      `[이론교육 · 10분] 시스템을 선정한다 ${sourceA}, ${sourceB}.\n` +
      `${SOP_APPLICATION_MARKER} 역할을 확인한다. [임의로 만든 교범 p.999]`;

    const stripped = stripDocumentInlineSourceRefsFromText(content, [sourceA, sourceB]);

    expect(stripped).toContain("[이론교육 · 10분]");
    expect(stripped).toContain(SOP_APPLICATION_MARKER);
    expect(stripped).toContain("시스템을 선정한다.");
    expect(stripped).not.toContain(sourceA);
    expect(stripped).not.toContain(sourceB);
    expect(stripped).not.toContain("임의로 만든 교범");
    expect(stripped).not.toMatch(/\s+[,.]/);
  });

  it("전체 문서와 부분 재생성 섹션에 같은 결정론적 후처리를 적용한다", () => {
    const plan = validPlan();
    plan.sections[0].content += ` ${sourceA}`;
    plan.sections[1].content += ` ${sourceB}`;

    const strippedDoc = stripDocumentInlineSourceRefs(plan, [sourceA, sourceB]);
    const strippedSection = stripSectionInlineSourceRefs(
      { heading: "훈련목표", content: `수행할 수 있다 ${sourceA}` },
      [sourceA]
    );

    expect(strippedDoc.sections.every((section) => !section.content.includes("로프구조"))).toBe(
      true
    );
    expect(strippedSection).toEqual({ heading: "훈련목표", content: "수행할 수 있다" });
    expect(plan.sections[0].content).toContain(sourceA);
  });
});

describe("결정론적 생성 품질 검사", () => {
  it("충분한 훈련계획은 통과한다", () => {
    expect(inspectGeneratedPlan(validPlan(), "1시간")).toEqual({ ok: true, issues: [] });
  });

  it("훈련내용에 교관·대원 수행, 피드백, 실수 교정이 빠지면 보완 대상으로 잡는다", () => {
    const plan = validPlan();
    plan.sections[1].content =
      "[이론교육 · 10분] 교관은 점검 목적을 설명하고 대원은 핵심 용어를 확인한다. " +
      "[교관시범 · 10분] 교관은 정상 순서를 설명하고 대원은 순서를 따라간다. " +
      "[반복실습 · 25분] 대원은 절차를 반복 수행하고 교관은 결과를 확인한다. " +
      "[종합수행 · 15분] 대원은 전 과정을 수행하고 교관은 마무리한다. " +
      fill("각 단계는 정해진 순서와 역할에 따라 진행한다.", 100);

    expect(inspectGeneratedPlan(plan, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_instructional_detail", path: "sections.1.content" }),
        expect.objectContaining({ code: "missing_error_correction", path: "sections.1.content" }),
        expect.objectContaining({ code: "missing_trainee_action_steps", path: "sections.1.content" }),
        expect.objectContaining({ code: "missing_exception_response", path: "sections.1.content" }),
      ])
    );
  });

  it("번호 행동이 있어도 수행 결과를 확인할 지점이 없으면 보완 대상으로 잡는다", () => {
    const plan = validPlan();
    plan.sections[1].content =
      "[이론교육 · 10분] 교관은 역할을 설명하고 대원은 지정 위치로 이동한다. " +
      "[교관시범 · 10분] 교관은 동작을 보여 주고 대원은 순서를 말한다. " +
      "[반복실습 · 25분] 대원 행동절차:\n" +
      "1) 지정된 위치로 이동한다.\n" +
      "2) 역할에 따라 장비를 배치한다.\n" +
      "3) 수행 내용을 교관에게 보고한다.\n" +
      "이상 시: 즉시 중단하고 교관에게 보고한 뒤 누락 동작을 교정하여 다시 수행한다. " +
      "교관은 피드백하고 대원은 역할을 교대한다. " +
      "[종합수행 · 15분] 대원은 같은 행동을 반복하고 교관은 기록한다. " +
      fill("흔한 실수는 역할 누락이며 교관의 설명에 따라 보완한다.", 90);

    expect(inspectGeneratedPlan(plan, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_action_verification", path: "sections.1.content" }),
      ])
    );
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

  it("판단 장의 근거와 실습 장의 실수·교정을 장별로 점검한다", () => {
    const deck = validSlides();
    deck.slides[6].bullets = [
      "출동 현장 상황을 읽고 가장 먼저 할 조치를 선택합니다",
      "선택한 조치를 동료에게 알리고 다음 대응을 결정합니다",
    ];
    deck.slides[6].notes = fill(
      "교관은 현장 상황을 설명하고 대원에게 우선 조치를 선택하게 합니다. 대원은 선택한 행동을 말합니다.",
      165
    );
    deck.slides[7].bullets = [
      "대원은 2인 1조로 점검 순서를 직접 수행하고 역할을 교대합니다",
      "동료는 수행 과정을 관찰하고 완료 여부를 알려 줍니다",
    ];
    deck.slides[7].notes = fill(
      "교관은 대원이 순서를 직접 수행하게 하고 동료와 역할을 교대하게 합니다. 모든 대원이 수행을 끝내면 확인합니다.",
      165
    );
    deck.slides[7].steps = ["순서 수행", "역할 교대", "완료 확인"];

    expect(inspectGeneratedSlides(deck, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_decision_rationale", path: "slides.6" }),
        expect.objectContaining({ code: "missing_error_correction", path: "slides.7" }),
        expect.objectContaining({ code: "missing_trainee_action_steps", path: "slides.7" }),
        expect.objectContaining({ code: "missing_exception_response", path: "slides.7" }),
      ])
    );
  });

  it("화학보호복 보호등급을 비교 장 밖에서 섞으면 차단하고 명시적 비교는 허용한다", () => {
    const mixed = validSlides();
    mixed.title = "화학보호복 착용과 탈의";
    mixed.slides[1].bullets[0] = "Level A 화학보호복의 착용 전 점검 항목을 확인합니다";
    mixed.slides[2].bullets[0] = "C급 보호복의 탈의 순서를 동료와 함께 점검합니다";

    expect(inspectGeneratedSlides(mixed, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "mixed_chemical_protection_levels",
          path: "slides.1",
        }),
        expect.objectContaining({
          code: "mixed_chemical_protection_levels",
          path: "slides.2",
        }),
      ])
    );

    const comparison = validSlides();
    comparison.title = "화학보호복 보호등급 구분";
    comparison.slides[1] = {
      ...comparison.slides[1],
      title: "보호등급별 적용 조건을 구분합니다",
      role: "comparison",
      composition: "comparison",
      steps: ["Level A", "C급"],
      bullets: [
        "Level A와 C급 보호복의 적용 조건 차이를 근거로 비교합니다",
        "현장 위험성 평가에 따라 필요한 보호 수준을 구분합니다",
      ],
    };

    expect(
      inspectGeneratedSlides(comparison, "1시간").issues.map((issue) => issue.code)
    ).not.toContain("mixed_chemical_protection_levels");
  });

  it("같은 공기호흡기 진입 압력의 상충 수치는 잡고 단위만 다른 동등값은 허용한다", () => {
    const conflicting = validSlides();
    conflicting.title = "공기호흡기 착용 전 점검";
    conflicting.slides[1].bullets[0] = "진입 전 공기호흡기 용기 압력은 250bar 이상인지 확인합니다";
    conflicting.slides[2].bullets[0] = "진입 전 공기호흡기 용기 압력은 280bar 이상인지 확인합니다";

    expect(inspectGeneratedSlides(conflicting, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "conflicting_pressure_values", path: "slides.1" }),
        expect.objectContaining({ code: "conflicting_pressure_values", path: "slides.2" }),
      ])
    );

    const equivalent = validSlides();
    equivalent.title = "공기호흡기 착용 전 점검";
    equivalent.slides[1].bullets[0] = "진입 전 공기호흡기 용기 압력은 250bar 이상인지 확인합니다";
    equivalent.slides[2].bullets[0] = "진입 전 공기호흡기 용기 압력은 25MPa 이상인지 확인합니다";
    expect(
      inspectGeneratedSlides(equivalent, "1시간").issues.map((issue) => issue.code)
    ).not.toContain("conflicting_pressure_values");

    const differentCriteria = validSlides();
    differentCriteria.title = "공기호흡기 압력 기준";
    differentCriteria.slides[1].bullets[0] =
      "공기호흡기 용기의 정격 압력은 300bar이고 잔압 경보는 55bar입니다";
    expect(
      inspectGeneratedSlides(differentCriteria, "1시간").issues.map((issue) => issue.code)
    ).not.toContain("conflicting_pressure_values");
  });

  it("제독 순서를 보편 절차처럼 쓰면 적용 조건을 요구한다", () => {
    const unqualified = validSlides();
    unqualified.title = "화학보호복 제독과 탈의";
    unqualified.slides[3].bullets[0] = "제독은 물 → 제독제 → 물 순서로 진행합니다";

    expect(inspectGeneratedSlides(unqualified, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unqualified_decontamination_sequence",
          path: "slides.3",
        }),
      ])
    );

    unqualified.slides[3].bullets[1] =
      "오염물질을 식별하고 SDS로 물 사용 가능 여부와 제독제 적합성을 확인합니다";
    expect(
      inspectGeneratedSlides(unqualified, "1시간").issues.map((issue) => issue.code)
    ).not.toContain("unqualified_decontamination_sequence");
  });

  it("role·composition 과다 반복과 시나리오·실습 누락을 별도로 보고한다", () => {
    const repeated = validSlides();
    repeated.slides.forEach((slide) => {
      slide.role = "concept";
      slide.composition = "statement";
    });
    expect(inspectGeneratedSlides(repeated, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "repetitive_slide_role" }),
        expect.objectContaining({ code: "repetitive_slide_composition" }),
      ])
    );

    const missingFlow = validSlides();
    [6, 7].forEach((index) => {
      missingFlow.slides[index] = {
        ...missingFlow.slides[index],
        title: `${index + 1}번째 핵심 개념을 구분합니다`,
        bullets: [
          "장비의 구성 요소와 명칭을 자료에서 찾아 정확히 설명합니다",
          "각 구성 요소의 기능과 연결 관계를 순서대로 정리합니다",
        ],
        notes: fill(
          "교관은 장비 구성 요소의 명칭과 기능을 설명합니다. 대원은 자료에서 같은 용어를 찾아 읽습니다. 각 부위의 위치를 확인하고 연결 관계를 정리합니다. 교관은 핵심 용어의 뜻을 다시 질문합니다. 마지막에는 구성 요소별 기능을 함께 되짚습니다.",
          165
        ),
      };
    });
    expect(inspectGeneratedSlides(missingFlow, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_slide_scenario" }),
        expect.objectContaining({ code: "missing_slide_practice" }),
      ])
    );

    const instructorOnly = validSlides();
    instructorOnly.slides[7] = {
      ...instructorOnly.slides[7],
      title: "교관이 전체 절차를 먼저 시범합니다",
      bullets: [
        "교관은 장비 점검 절차를 처음부터 끝까지 천천히 시범합니다",
        "대원은 시범을 관찰하고 단계별 주의사항을 기록합니다",
      ],
      notes: fill(
        "교관은 전체 절차를 순서대로 보여 줍니다. 대원은 손의 위치와 확인 지점을 관찰합니다. 교관은 단계마다 동작의 목적을 설명합니다. 대원은 궁금한 내용을 질문하고 답을 기록합니다. 마지막에는 시범의 핵심 동작을 말로 정리합니다.",
        165
      ),
    };
    expect(
      inspectGeneratedSlides(instructorOnly, "1시간").issues.map((issue) => issue.code)
    ).toContain("missing_slide_practice");
  });

  it("현장 판단보다 실습이 먼저 나오면 학습 흐름 문제로 보고한다", () => {
    const deck = validSlides();
    [deck.slides[6], deck.slides[7]] = [deck.slides[7], deck.slides[6]];
    expect(inspectGeneratedSlides(deck, "1시간").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_slide_learning_flow", path: "slides" }),
      ])
    );
  });

  it("안전·요약 role과 layout만 지정한 슬라이드는 실제 안전·평가 내용으로 인정하지 않는다", () => {
    const deck = validSlides();
    deck.slides[8] = {
      ...deck.slides[8],
      title: "장비 구성 요소를 순서대로 학습합니다",
      bullets: [
        "용기와 면체 및 조정기의 명칭을 함께 읽고 위치를 찾아봅니다",
        "각 구성 요소가 서로 연결되는 방식과 기본 기능을 설명합니다",
      ],
      notes: fill(
        "교관은 장비의 구성 요소를 하나씩 가리키며 명칭을 설명합니다. 대원은 명칭을 따라 읽고 장비에서 같은 부위를 찾아봅니다. 각 부위가 연결되는 순서를 그림과 실물로 비교합니다. 이후 동료와 번갈아 명칭과 기능을 말합니다. 마무리로 오늘 다룬 구성 요소를 다시 정리합니다.",
        165
      ),
    };
    deck.slides[9] = {
      ...deck.slides[9],
      title: "교육에서 다룬 장비 구성 요소를 되짚습니다",
      bullets: [
        "용기와 면체 및 조정기의 이름과 위치를 차례로 떠올립니다",
        "구성 요소가 연결되는 흐름과 각 부위의 기능을 함께 정리합니다",
      ],
      notes: fill(
        "교관은 앞서 설명한 장비 구성 요소를 차례로 다시 보여 줍니다. 대원은 각 명칭과 기능을 소리 내어 말합니다. 그림에 표시된 위치와 실물의 위치를 서로 비교합니다. 조별로 역할을 바꾸어 같은 내용을 설명합니다. 마지막에는 장비 구성의 전체 흐름을 다시 정리합니다.",
        165
      ),
    };

    const codes = inspectGeneratedSlides(deck, "1시간").issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["missing_safety", "missing_evaluation"]));
  });

  it("실제 문구에 안전·중단 및 평가·판단 기준이 있으면 role·layout 값과 무관하게 인정한다", () => {
    const deck = validSlides();
    deck.slides[8] = { ...deck.slides[8], role: "concept", layout: "concept" };
    deck.slides[9] = { ...deck.slides[9], role: "concept", layout: "concept" };

    const codes = inspectGeneratedSlides(deck, "1시간").issues.map((issue) => issue.code);
    expect(codes).not.toContain("missing_safety");
    expect(codes).not.toContain("missing_evaluation");
  });

  it("슬라이드 제목·핵심 문장·단계어가 화면 한계를 넘으면 각각 보고한다", () => {
    const deck = validSlides();
    deck.slides[0] = {
      ...deck.slides[0],
      title: "제".repeat(MAX_SLIDE_TITLE_CHARS + 1),
      bullets: [
        "문".repeat(MAX_SLIDE_BULLET_CHARS + 1),
        deck.slides[0].bullets[1],
      ],
      steps: ["단".repeat(MAX_SLIDE_STEP_CHARS + 1), "확인", "보고"],
    };
    const issues = inspectGeneratedSlides(deck, "1시간").issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "slide_title_too_long",
          path: "slides.0.title",
        }),
        expect.objectContaining({
          code: "slide_bullet_too_long",
          path: "slides.0.bullets.0",
        }),
        expect.objectContaining({
          code: "slide_step_too_long",
          path: "slides.0.steps.0",
        }),
      ])
    );
  });

  it("화면 구도별 단계 계약과 원문 시각자료 출처·대체 텍스트를 검사한다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      role: "comparison",
      composition: "comparison",
      steps: ["기준 하나", "기준 둘", "불필요한 기준"],
      visual: {
        mode: "source-page",
        sourceRef: "[만들어낸 교범 p.99]",
      },
    };

    const issues = inspectGeneratedSlides(deck, "1시간", ["[공기호흡기 교육교범 p.3]"]).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_slide_composition",
          path: "slides.1.steps",
        }),
        expect.objectContaining({ code: "invalid_slide_visual", path: "slides.1.visual" }),
        expect.objectContaining({
          code: "invalid_slide_visual",
          path: "slides.1.visual.sourceRef",
        }),
        expect.objectContaining({
          code: "invalid_slide_visual",
          path: "slides.1.composition",
        }),
      ])
    );
  });

  it("유효한 원문 출처라도 visual-explanation이 아닌 화면에서는 거부한다", () => {
    const deck = validSlides();
    deck.slides[1] = {
      ...deck.slides[1],
      composition: "comparison",
      steps: ["정상", "이상"],
      visual: {
        mode: "source-page",
        sourceRef: "[공기호흡기 교육교범 p.3]",
        altText: "정상과 이상 상태를 보여 주는 원문 페이지",
      },
    };

    const issues = inspectGeneratedSlides(deck, "1시간", [
      "[공기호흡기 교육교범 p.3]",
    ]).issues;

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_slide_visual",
          path: "slides.1.composition",
        }),
      ])
    );
  });

  it("API와 화면에서 쓸 품질 경고 라벨을 중복 없이 요약한다", () => {
    const warnings = generationQualityWarnings({
      ok: false,
      issues: [
        { code: "slide_title_too_long", path: "slides.0.title", message: "긴 제목" },
        { code: "slide_title_too_long", path: "slides.1.title", message: "긴 제목" },
        { code: "slide_bullet_too_long", path: "slides.0.bullets.0", message: "긴 문장" },
      ],
    });
    expect(warnings).toEqual([
      GENERATION_QUALITY_LABELS.slide_title_too_long,
      GENERATION_QUALITY_LABELS.slide_bullet_too_long,
    ]);
  });

  it("공식 출력 차단 오류와 교관 검토 경고를 같은 보고서에서 분리한다", () => {
    const messages = generationQualityMessages({
      ok: false,
      issues: [
        {
          code: "time_total_mismatch",
          path: "sections",
          message: "시간 합계가 다름",
        },
        {
          code: "missing_safety",
          path: "sections.3.content",
          message: "안전 기준 누락",
        },
        {
          code: "slide_title_too_long",
          path: "slides.0.title",
          message: "제목이 김",
        },
      ],
    });

    expect(messages.errors).toEqual([
      GENERATION_QUALITY_LABELS.time_total_mismatch,
      GENERATION_QUALITY_LABELS.missing_safety,
    ]);
    expect(messages.warnings).toEqual([
      GENERATION_QUALITY_LABELS.slide_title_too_long,
    ]);
  });

  it("슬라이드의 실제 참고 자료에 없는 출처를 품질 문제로 잡는다", () => {
    const allowed = ["[공기호흡기 교육교범 p.3]"];
    const deck = validSlides();
    deck.slides[0].sourceRefs = ["[만들어낸 교범 p.99]"];
    expect(inspectGeneratedSlides(deck, "1시간", allowed).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_source_ref" })])
    );
  });

  it("계획·교안의 모든 필수 섹션에서 페이지 없는 허위 대괄호 출처도 잡는다", () => {
    const allowed = "[공기호흡기 교육교범 p.3]";
    const cases = [
      {
        type: "plan",
        draft: citeSections(
          validPlan(),
          ["훈련내용", "필요장비", "안전관리"],
          allowed
        ),
        headings: TRAINING_PLAN_SECTIONS,
      },
      {
        type: "lesson",
        draft: citeSections(
          validLesson(),
          ["핵심이론", "교관시범", "안전유의사항"],
          allowed
        ),
        headings: LESSON_SECTIONS,
      },
    ] as const;

    for (const { type, draft, headings } of cases) {
      for (const heading of headings) {
        const tampered = structuredClone(draft);
        const index = tampered.sections.findIndex((section) => section.heading === heading);
        tampered.sections[index].content += ` [검증되지 않은 ${heading} 자료]`;
        const quality = type === "plan"
          ? inspectGeneratedPlan(tampered, "1시간", [allowed])
          : inspectGeneratedLesson(tampered, "1시간", [allowed]);

        expect(quality.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_source_ref",
              path: `sections.${index}.content`,
            }),
          ])
        );
      }
    }
  });

  it("시간 배분·SOP 적용 표식은 출처로 오인하지 않고 페이지 없는 허용 라벨은 인정한다", () => {
    const allowed = "[공기호흡기 교육교범]";
    const plan = citeSections(
      validPlan(),
      ["훈련내용", "필요장비", "안전관리"],
      allowed
    );
    plan.sections[1].content = `${SOP_APPLICATION_MARKER}\n${plan.sections[1].content}`;
    plan.sections[0].content += " [시간: 00분]";
    const lesson = citeSections(
      validLesson(),
      ["핵심이론", "교관시범", "안전유의사항"],
      allowed
    );
    lesson.sections[2].content = `${SOP_APPLICATION_MARKER}\n${lesson.sections[2].content}`;

    expect(
      inspectGeneratedPlan(plan, "1시간", [allowed]).issues.filter(
        (issue) => issue.code === "invalid_source_ref"
      )
    ).toEqual([]);
    expect(
      inspectGeneratedLesson(lesson, "1시간", [allowed]).issues.filter(
        (issue) => issue.code === "invalid_source_ref"
      )
    ).toEqual([]);
  });

  it("편집본은 API가 보관한 실제 출처 라벨로 다시 검사한다", () => {
    const deck = {
      ...validSlides(),
      sources: [],
      sourceLabels: ["[공기호흡기 교육교범 p.3]"],
    };
    deck.slides[0].sourceRefs = ["[만들어낸 교범 p.99]"];

    expect(inspectCurrentGenerationQuality("slides", deck, "1시간").issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_source_ref" })])
    );
  });

  it("과거 저장본에 허용 출처 목록이 없으면 재검증 불가를 명확히 알린다", () => {
    const legacyDeck = {
      ...validSlides(),
      sources: [],
    };

    const quality = inspectCurrentGenerationQuality("slides", legacyDeck, "1시간");
    expect(quality.ok).toBe(false);
    expect(quality.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source_validation_unavailable", path: "sourceLabels" }),
      ])
    );
    expect(GENERATION_QUALITY_LABELS.source_validation_unavailable).toBe(
      "근거 출처 재검증 정보"
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
        conditions: "대원 8명 / 장비 4세트",
      },
      draft,
      report: quality,
    });

    expect(prompt).toContain("[thin_content]");
    expect(prompt).toContain(TRAINING_PLAN_SECTIONS.join(" → "));
    expect(prompt).toContain(JSON.stringify(draft, null, 2));
    expect(prompt).toContain("일반 상식·수치·절차·사례를 만들지 마세요");
    expect(prompt).toContain("전체 JSON 객체만 반환");
    expect(prompt).toContain("현장 조건(사용자 입력): 대원 8명 / 장비 4세트");
    expect(prompt).toContain("최소 3개의 번호 행동");
    expect(prompt).toContain("판단 조건 → 행동 → 확인 → 보고");
  });

  it("슬라이드 안전 정합성 보완은 수치·절차를 임의로 통일하지 않도록 제한한다", () => {
    const draft = validSlides();
    draft.title = "공기호흡기 착용 전 점검";
    draft.slides[1].bullets[0] = "진입 전 공기호흡기 용기 압력은 250bar 이상인지 확인합니다";
    draft.slides[2].bullets[0] = "진입 전 공기호흡기 용기 압력은 280bar 이상인지 확인합니다";
    const quality = inspectGeneratedSlides(draft, "1시간");
    const prompt = buildGenerationRepairPrompt({
      type: "slides",
      request: {
        category: "화재",
        audience: "일반 대원",
        duration: "1시간",
        topic: "공기호흡기 착용 전 점검",
      },
      draft,
      report: quality,
    });

    expect(prompt).toContain("[conflicting_pressure_values]");
    expect(prompt).toContain("값을 임의로 하나로 통일하거나 새 절차를 만들지 마세요");
    expect(prompt).toContain("참고 자료에서 확인되지 않습니다");
    expect(prompt).toContain("현장 상황 판단 → 대원 참여 실습 → 수행평가");
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
