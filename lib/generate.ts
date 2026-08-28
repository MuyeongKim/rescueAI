// 교육자료·훈련계획 생성 — 스키마·옵션·프롬프트의 단일 출처.
// UI는 클릭·선택형(자유 입력 최소화): 유형 × 분야 × 대상 × 시간 조합으로 생성한다.
import { z } from "zod";

// ── 생성 유형 ──
export const GEN_TYPES = [
  {
    key: "plan",
    label: "훈련계획",
    description: "목표·준비물·단계별 진행·평가가 담긴 훈련계획 문서",
  },
  {
    key: "lesson",
    label: "교육자료(교안)",
    description: "교육 시간에 바로 쓰는 강의용 교안(개요·본문·정리)",
  },
  {
    key: "slides",
    label: "슬라이드(PPTX)",
    description: "표준 양식 PPTX 슬라이드 자동 생성 (발표자 노트 포함)",
  },
  {
    key: "notebooklm",
    label: "NotebookLM 프롬프트",
    description: "NotebookLM에 붙여넣어 슬라이드를 만들 프롬프트 생성",
  },
] as const;
export type GenType = (typeof GEN_TYPES)[number]["key"];

// ── 선택 옵션 ──
export const AUDIENCES = ["신임 대원", "일반 대원", "전문 과정"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const DURATIONS = ["1시간", "2시간", "4시간"] as const;
export type Duration = (typeof DURATIONS)[number];

export const MAX_GENERATION_CONDITIONS_CHARS = 500;

export type GenerateRequest = {
  type: GenType;
  category: string;
  audience: Audience;
  duration: Duration;
  topic?: string; // 선택: 훈련 내용/주제(예: "공기호흡기 점검")
  date?: string; // 선택: 훈련 일자 (YYYY-MM-DD)
  place?: string; // 선택: 훈련 장소(훈련계획 양식용)
  conditions?: string; // 선택: 인원·교관·보유 장비·훈련장 등 현장 조건(최대 500자)
  model?: string; // 선택: LLM 모델 키 (lib/llm.ts MODEL_OPTIONS, 미지정 시 서버 기본)
};

// 훈련계획 양식(training_plan.hwpx)의 AI 생성 섹션 — 제목이 고정이라 템플릿 매핑이 확정적이다.
// 이 순서·제목으로 정확히 생성되어야 /api/hwp 가 자리표시자에 안전하게 매핑한다.
export const TRAINING_PLAN_SECTIONS = [
  "훈련목표",
  "훈련내용",
  "필요장비",
  "안전관리",
  "훈련평가",
] as const;

// 교안은 설명문만 길게 늘어놓지 않고 실제 교육 흐름이 이어지도록 순서를 고정한다.
export const LESSON_SECTIONS = [
  "학습목표",
  "도입",
  "핵심이론",
  "교관시범",
  "대원실습",
  "안전유의사항",
  "정리·평가",
] as const;

// ── 생성 결과 ──
const generatedSectionSchema = z.object({
  heading: z.string().describe("섹션 제목"),
  content: z.string().describe("섹션 본문. 줄바꿈(\\n)으로 항목 구분"),
});

// 과거 저장본·문서 변환기와의 호환용 범용 스키마. 신규 생성은 아래 유형별 스키마를 사용한다.
export const generatedDocSchema = z.object({
  title: z.string().describe("문서 제목 (분야·주제·시간이 드러나게)"),
  sections: z.array(generatedSectionSchema).min(3).max(8),
});

export type GeneratedSection = z.infer<typeof generatedDocSchema>["sections"][number];

function exactSectionsSchema<const T extends readonly [string, ...string[]]>(
  headings: T,
  contentDescription: string
) {
  return z
    .array(
      z.object({
        heading: z.enum(headings).describe(`고정 섹션 제목: ${headings.join(", ")}`),
        content: z.string().min(1).describe(contentDescription),
      })
    )
    .length(headings.length)
    .superRefine((sections, ctx) => {
      headings.forEach((heading, index) => {
        if (sections[index]?.heading === heading) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "heading"],
          message: `${index + 1}번째 섹션 제목은 '${heading}'이어야 합니다.`,
        });
      });
    });
}

// HWPX 표준 양식과 1:1 매핑되는 정확히 다섯 개 섹션. 제목·순서·개수 모두 스키마로 고정한다.
export const generatedPlanSchema = z.object({
  title: z.string().describe("훈련계획 제목 (분야·구체적 주제·대상·시간이 드러나게)"),
  sections: exactSectionsSchema(
    TRAINING_PLAN_SECTIONS,
    "해당 고정 제목의 역할에 맞는 구체적 내용. 시간·장비·안전·평가 요구사항을 프롬프트대로 작성"
  ),
});

// 교관이 그대로 진행할 수 있도록 도입→이론→시범→실습→안전→평가의 실습형 흐름을 고정한다.
export const generatedLessonSchema = z.object({
  title: z.string().describe("교안 제목 (분야·구체적 주제·대상·시간이 드러나게)"),
  sections: exactSectionsSchema(
    LESSON_SECTIONS,
    "도입→이론→교관 시범→대원 실습→안전→정리·평가 흐름에서 해당 고정 제목의 역할에 맞는 상세 내용"
  ),
});

export type GeneratedPlan = z.infer<typeof generatedPlanSchema>;
export type GeneratedLesson = z.infer<typeof generatedLessonSchema>;

/** 신규 문서 생성에서 요청 유형에 맞는 강한 스키마를 선택한다. */
export function generatedDocSchemaFor(
  type: "plan" | "lesson"
): z.ZodType<GeneratedDocDraft> {
  return type === "plan" ? generatedPlanSchema : generatedLessonSchema;
}

export type GeneratedDocSource = {
  document_id: number;
  doc: string;
  page: number | null;
};

export type GeneratedDoc = {
  title: string;
  sections: GeneratedSection[];
  sources: GeneratedDocSource[];
  /** 생성 당시 RAG 컨텍스트에서 허용된 정확한 출처 라벨. 편집 후 재검사용. */
  sourceLabels?: string[];
};

// ── 슬라이드(PPTX) 생성 결과 ──
export const SLIDE_LAYOUT_TYPES = [
  "objectives",
  "concept",
  "process",
  "equipment",
  "case",
  "safety",
  "summary",
] as const;
export type SlideLayoutType = (typeof SLIDE_LAYOUT_TYPES)[number];

const generatedSlideSchema = z.object({
  title: z
    .string()
    .describe("이 장에서 기억할 결론이 드러나는 서술형 제목 (25자 내외)"),
  bullets: z
    .array(z.string().describe("근거가 있는 구체적 핵심 문장 (한 줄, 55자 내외)"))
    .min(1)
    .max(4),
  steps: z
    .array(z.string().describe("단계 핵심어 (짧게, 10자 내외)"))
    .min(3)
    .max(5)
    .optional()
    .describe("절차·흐름이 있는 슬라이드에만 순서대로 3~5개 단계어"),
  notes: z
    .string()
    .describe("교관이 그대로 활용할 수 있는 설명 대본. 근거·시범 포인트·질문을 포함한 4~7문장"),
  layout: z
    .enum(SLIDE_LAYOUT_TYPES)
    .optional()
    .describe("내용 의미에 맞는 레이아웃 유형. 과거 저장본 호환을 위해 선택 필드"),
  sourceRefs: z
    .array(
      z
        .string()
        .describe("참고 자료에 표시된 출처 라벨을 그대로 적은 인용 (예: [문서명 p.3])")
    )
    .min(1)
    .max(4)
    .optional()
    .describe("이 슬라이드의 근거 출처. 과거 저장본 호환을 위해 선택 필드"),
});

export const generatedSlidesSchema = z.object({
  title: z.string().describe("발표 제목 (분야·주제가 드러나게, 25자 이내)"),
  slides: z.array(generatedSlideSchema).min(6).max(20),
});

export type GeneratedSlide = z.infer<typeof generatedSlidesSchema>["slides"][number];

export type GeneratedSlideDeck = {
  title: string;
  slides: GeneratedSlide[];
  sources: GeneratedDocSource[];
  /** 생성 당시 RAG 컨텍스트에서 허용된 정확한 출처 라벨. 편집 후 재검사용. */
  sourceLabels?: string[];
};

// ── 시스템 프롬프트 (단일 출처) ──
// route.ts(전체 생성)·section/route.ts(부분 재생성)가 공유한다.
// 교관 페르소나 + 근거(RAG) 규칙 + 품질/표현 기준을 담아 결과물 수준을 높인다.
// 인용 자료(contextText)는 항상 마지막에 붙여 "이 자료 = 유일한 근거"임을 명확히 한다.
export function buildGenerateSystemPrompt(category: string, contextText: string): string {
  return `당신은 전북소방본부의 ${category} 분야 교육훈련을 20년간 맡아 온 베테랑 교관이자 교육기획 담당관입니다.
현장 대원이 그대로 사용할 수 있는, 정확하고 실전적인 교육 문서를 작성합니다.

[근거 규칙 — 가장 중요]
- 아래 [참고 자료]에 있는 내용만 근거로 작성합니다. 자료에 없는 절차·수치·장비명·규정을 지어내지 마세요.
- 참고 자료가 특정 항목을 다루지 않으면, 억지로 채우지 말고 자료에 담긴 범위 안에서 충실히 구성합니다.
- 일반 상식이나 타 기관 기준을 임의로 끌어오지 않습니다. 근거는 오직 이 자료입니다.
- 참고 자료에 없는 내용은 "참고 자료에서 확인되지 않습니다"라고 명시합니다. 분량을 늘리기 위해 추측하지 않습니다.
- 출처는 참고 자료에 표시된 라벨을 글자 하나 바꾸지 않고 그대로 인용합니다(예: [문서명 p.3]).
- 출처 라벨만으로 뒷받침되지 않는 새로운 주장·수치·절차를 추가하지 않습니다.

[품질 기준]
- 추상적 서술("철저히 한다", "숙지한다")을 지양하고, 동작·수치·순서로 구체화합니다
  (예: "주 결합부를 손으로 당겨 풀림 여부를 확인"). 수치는 참고 자료나 사용자 현장 조건에서 확인될 때만 씁니다.
- 안전을 최우선으로: 위험 요소와 안전조치를 눈에 띄게 포함합니다.
- 현장 용어와 표준 절차를 정확히 사용하되, 대상 수준에 맞는 난이도로 풀어씁니다.
- 시간이 지정되면 단계별 시간 배분의 합이 전체 교육 시간과 일치해야 합니다.
- 교관이 별도 보충 없이 진행할 수 있도록 행동 이유·적용 조건·교관 설명·실습 피드백·평가 기준을 충분히 씁니다.
- 신임 대원은 용어를 처음 등장할 때 풀어 설명하고, 일반 대원은 현장 적용과 실수를, 전문 과정은 판단 조건과 예외를 강조합니다.

[표현]
- 격식 있는 한국어로, 군더더기 없이 작성합니다.
- 훈련계획·준비물·점검 항목처럼 목록형 내용은 개조식(명사형 종결)으로 간결하게, 바로 실행할 수 있는 행동 지시형으로 씁니다.
- 교안 본문·도입 설명·발표자 노트처럼 설명이 필요한 부분은 읽기 자연스러운 문장으로 풀어 씁니다(개조식으로 누르지 않습니다).

[참고 자료]
${contextText}`;
}

// ── 프롬프트 ──
// 시간별 권장 슬라이드 수 (NotebookLM 안내와 동일 기준, 스키마 상한 20장)
export function slideCountFor(duration: Duration): string {
  return duration === "1시간" ? "10~12" : duration === "2시간" ? "14~18" : "18~20";
}

export function slideCountRangeFor(duration: Duration): readonly [number, number] {
  return duration === "1시간" ? [10, 12] : duration === "2시간" ? [14, 18] : [18, 20];
}

function normalizedConditions(value?: string): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GENERATION_CONDITIONS_CHARS);
}

function conditionPromptParts(value?: string): { line: string; rule: string } {
  const conditions = normalizedConditions(value);
  if (conditions) {
    return {
      line: `\n- 현장 조건(사용자 입력): ${conditions}`,
      rule:
        "사용자가 입력한 현장 조건의 인원·교관·장비 수량은 그대로 반영하되, 입력되지 않은 수량이나 조건을 추가로 추정하지 마세요.",
    };
  }
  return {
    line: "\n- 현장 조건: 입력되지 않음",
    rule:
      "현장 조건이 입력되지 않았으므로 참여 인원·교관 수·조 편성 인원·장비 수량을 임의로 특정하지 마세요. 수량이 꼭 필요한 항목은 '현장 여건에 따라 결정' 또는 '참고 자료에서 확인되지 않습니다'로 표시하세요.",
  };
}

export function buildGeneratePrompt(req: GenerateRequest): string {
  if (req.type === "notebooklm") {
    throw new Error("notebooklm 유형은 buildNotebookLmPrompt 를 사용하세요.");
  }
  const topicLine = req.topic?.trim()
    ? `훈련 내용(주제): ${req.topic.trim()}`
    : "훈련 내용(주제): 분야 전반에서 가장 중요한 주제를 선정";
  const dateLine = req.date ? `\n- 훈련 일자: ${req.date} (문서 개요에 명시)` : "";
  const condition = conditionPromptParts(req.conditions);

  if (req.type === "slides") {
    return `전북소방본부 ${req.category} 분야 교육용 슬라이드를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration} (슬라이드 ${slideCountFor(req.duration)}장)
- ${topicLine}${condition.line}

[구성]
① 측정 가능한 학습 목표 1장 ② 핵심 개념·절차(단계별로 1장씩) ③ 장비·사전점검
④ 현장 판단 사례 ⑤ 위험요소·중단 기준 ⑥ 핵심 요약과 확인 질문 1장

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 각 슬라이드 제목은 "안전 유의사항" 같은 분류명이 아니라, "압력이 부족하면 진입하지 않습니다"처럼
  그 장에서 기억할 결론이 드러나는 서술형 문장으로 쓰고 ${MAX_SLIDE_TITLE_CHARS}자 이내로 제한하세요.
- 화면에는 구체적인 핵심 문장 2~4개만 두고, 각 문장은 ${MAX_SLIDE_BULLET_CHARS}자 이내로 제한하며 한 장에는 하나의 메시지만 담으세요.
- 발표자 노트는 4~7문장으로 충분히 작성하세요. 근거가 되는 이유·교관이 보여줄 시범·대원에게 던질 질문·
  실수하기 쉬운 지점 중 해당되는 내용을 포함하여 교관이 그대로 설명할 수 있게 하세요.
- **절차·단계·흐름을 다루는 슬라이드**(예: 대응 절차, 착용 순서)에는 steps 에 3~5개 단계 핵심어를
  순서대로 넣되 각 단계어는 ${MAX_SLIDE_STEP_CHARS}자 이내로 제한하세요(예: ["초동대응","진압·구조","사후처리"]). 흐름이 아닌 슬라이드는 steps 를 넣지 마세요.
- 각 슬라이드에 내용 의미와 맞는 layout을 지정하세요: objectives, concept, process, equipment, case, safety, summary.
- 각 슬라이드의 sourceRefs에 그 장의 근거가 된 참고 자료 라벨을 1~4개 넣으세요.
  라벨은 [참고 자료]에 표시된 형태(예: [문서명 p.3])를 그대로 복사하며, 없는 출처를 만들지 마세요.
- 같은 제목이나 같은 핵심 문장을 다른 슬라이드에서 반복하지 마세요. 마지막 요약은 앞 내용을 더 짧게 종합하세요.
- 대상 수준(${req.audience})에 맞는 용어와 난이도로, 한국어로 작성하세요.`;
  }

  // 훈련계획: 전북소방 표준 양식(training_plan.hwpx)에 맞춰 '고정 제목 5개 섹션'으로 생성.
  if (req.type === "plan") {
    const placeLine = req.place?.trim() ? `\n- 훈련 장소: ${req.place.trim()}` : "";
    return `전북소방본부 ${req.category} 분야 구조 훈련 계획서의 '내용'을 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration}
- ${topicLine}${dateLine}${placeLine}${condition.line}

아래 5개 항목을 **정확히 이 제목으로, 이 순서대로** 각각 하나의 섹션(heading=제목, content=내용)으로만 작성하세요. 다른 섹션을 추가하지 마세요.
1. 훈련목표 — 교육 후 대원이 실제로 수행하거나 설명할 수 있는 측정 가능한 목표 2~4개.
2. 훈련내용 — 이론교육·교관시범·반복실습·종합수행의 순서, 교관 행동, 대원 행동, 피드백 방법을 구체적으로 작성.
   각 단계 소제목에 [이론교육 · 20분]처럼 대괄호 안에 시간을 넣고, 표시한 시간 합계를 정확히 ${req.duration}으로 맞추세요.
3. 필요장비 — 장비명만 나열하지 말고 용도·사용 전 점검사항을 함께 작성. 수량은 현장 조건이나 참고 자료에서 확인되는 경우에만 명시.
4. 안전관리 — 위험요소별 예방조치, 안전담당 역할, 즉시 중단해야 할 상태와 보고 절차를 작성.
5. 훈련평가 — "이해했다"가 아니라 체크리스트로 관찰 가능한 수행 기준·통과 기준·강평 항목을 작성.

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치·장비명을 지어내지 마세요.
- ${condition.rule}
- 대상 수준(${req.audience})에 맞는 난이도로, 현장에서 바로 쓸 수 있게 구체적으로 작성하세요.
- 근거가 있는 핵심 절차·수치·장비·안전 기준 뒤에는 참고 자료의 출처 라벨을 그대로 붙이세요.
- 자료에 없는 수량·중단 기준·평가기준은 임의로 만들지 말고 "참고 자료에서 확인되지 않습니다"라고 밝히세요.
- 한국어로 작성하세요.`;
  }

  return `전북소방본부 ${req.category} 분야 교육자료(교안)를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration}
- ${topicLine}${dateLine}${condition.line}

[고정 구성 — 정확히 이 제목과 순서로 7개 섹션]
1. 학습목표 — 교육 종료 후 대원이 설명하거나 수행할 수 있는 측정 가능한 목표 2~4개.
2. 도입 — [시간: 00분]으로 시작. 실제 현장 상황 또는 확인 질문으로 필요성을 느끼게 하고 오늘 배울 내용을 연결.
3. 핵심이론 — [시간: 00분]으로 시작. 단순 정의가 아니라 이유·적용 조건·절차·주의점을 소단원으로 풀어 설명.
4. 교관시범 — [시간: 00분]으로 시작. 교관의 동작·말할 내용·대원이 관찰할 지점을 순서대로 작성.
5. 대원실습 — [시간: 00분]으로 시작. 조 편성·역할·반복 방법·교관 피드백·실수 교정 방법을 작성.
6. 안전유의사항 — [시간: 00분]으로 시작. 위험요소·예방조치·즉시 중단 및 보고 기준을 작성.
7. 정리·평가 — [시간: 00분]으로 시작. 핵심 요약, 확인 질문과 모범답안, 관찰 가능한 수행평가 기준을 작성.

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 각 섹션을 교관이 별도 내용을 보충하지 않아도 진행할 수 있을 만큼 구체적으로 작성하세요.
- 대상 수준(${req.audience})에 맞춰 용어 설명·현장 적용·판단 조건의 깊이를 조절하세요.
- 대괄호로 표시한 여섯 단계의 시간 배분 합이 교육 시간(${req.duration})과 정확히 일치해야 합니다.
- 근거가 있는 핵심 주장 뒤에는 참고 자료의 출처 라벨을 그대로 붙이세요.
- 참고 자료가 다루지 않는 사례·수치·절차는 지어내지 말고 "참고 자료에서 확인되지 않습니다"라고 밝히세요.
- 한국어로, 현장에서 바로 쓸 수 있게 구체적으로 작성하세요.`;
}

// ── 생성 결과 품질 검사 (순수·결정론적) ──
// LLM 자기평가에 의존하지 않고 구조·분량·시간·안전·평가·중복을 빠르게 검사한다.
export const MIN_SLIDE_NOTES_CHARS = 140;
export const MAX_SLIDE_TITLE_CHARS = 34;
export const MAX_SLIDE_BULLET_CHARS = 70;
export const MAX_SLIDE_STEP_CHARS = 12;

export type GenerationQualityIssueCode =
  | "missing_section"
  | "unexpected_section"
  | "section_order"
  | "thin_content"
  | "missing_safety"
  | "missing_evaluation"
  | "missing_time_allocation"
  | "time_total_mismatch"
  | "slide_count"
  | "thin_notes"
  | "slide_title_too_long"
  | "slide_bullet_too_long"
  | "slide_step_too_long"
  | "duplicate_slide_title"
  | "duplicate_slide_content"
  | "missing_slide_layout"
  | "generic_slide_title"
  | "missing_source_citation"
  | "missing_source_refs"
  | "invalid_source_ref"
  | "source_validation_unavailable";

export type GenerationQualityIssue = {
  code: GenerationQualityIssueCode;
  path: string;
  message: string;
};

export type GenerationQualityReport = {
  ok: boolean;
  issues: GenerationQualityIssue[];
};

export const GENERATION_QUALITY_LABELS = {
  missing_section: "필수 구성 누락",
  unexpected_section: "예정되지 않은 구성",
  section_order: "구성 순서",
  thin_content: "일부 내용의 구체성·분량",
  missing_safety: "안전·중단 기준",
  missing_evaluation: "평가·통과 기준",
  missing_time_allocation: "단계별 시간 배분",
  time_total_mismatch: "교육 시간 합계",
  slide_count: "교육 시간에 맞는 슬라이드 수",
  thin_notes: "일부 발표자 노트 분량",
  slide_title_too_long: "일부 슬라이드 제목 길이",
  slide_bullet_too_long: "일부 슬라이드 핵심 문장 길이",
  slide_step_too_long: "일부 슬라이드 단계어 길이",
  duplicate_slide_title: "중복 슬라이드 제목",
  duplicate_slide_content: "중복 슬라이드 내용",
  missing_slide_layout: "슬라이드 구성 방식",
  generic_slide_title: "슬라이드 결론형 제목",
  missing_source_citation: "핵심 내용의 근거 출처",
  missing_source_refs: "슬라이드별 근거 출처",
  invalid_source_ref: "근거 출처 표기",
  source_validation_unavailable: "근거 출처 재검증 정보",
} as const satisfies Record<GenerationQualityIssueCode, string>;

/** API와 클라이언트가 동일한 사용자용 품질 경고 문구를 사용하도록 변환한다. */
export function generationQualityWarnings(
  quality: GenerationQualityReport,
  extraLabels: readonly string[] = [],
  limit = 4
): string[] {
  const labels = Array.from(
    new Set([
      ...extraLabels,
      ...quality.issues.map((issue) => GENERATION_QUALITY_LABELS[issue.code]),
    ])
  );
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 4;
  const warnings = labels.slice(0, safeLimit);
  if (labels.length > warnings.length) {
    warnings.push(`그 밖의 점검 항목 ${labels.length - warnings.length}개`);
  }
  return warnings;
}

export type GeneratedDocDraft = Pick<GeneratedDoc, "title" | "sections">;
export type GeneratedSlideDeckDraft = Pick<GeneratedSlideDeck, "title" | "slides">;

const PLAN_MIN_CHARS: Record<(typeof TRAINING_PLAN_SECTIONS)[number], number> = {
  훈련목표: 50,
  훈련내용: 220,
  필요장비: 40,
  안전관리: 100,
  훈련평가: 90,
};

const LESSON_MIN_CHARS: Record<(typeof LESSON_SECTIONS)[number], number> = {
  학습목표: 70,
  도입: 120,
  핵심이론: 260,
  교관시범: 200,
  대원실습: 200,
  안전유의사항: 120,
  "정리·평가": 180,
};

const SAFETY_CUE = /안전|위험|보호|예방|통제|점검|감시|대피/;
const STOP_OR_REPORT_CUE = /중단|보고|철수|대피|비상|이상|사고/;
const EVALUATION_CUE = /평가|확인|관찰|체크|수행|시연|질문|강평/;
const EVALUATION_STANDARD_CUE = /기준|통과|정확|누락|횟수|시간|모범답안|체크리스트/;
const SOURCE_REF_FORMAT = /^\[[^\[\]\r\n]{2,}\]$/;
const INLINE_SOURCE_REF = /\[[^\[\]\r\n]{2,}\]/g;
const GENERIC_SLIDE_TITLES = new Set([
  "학습목표",
  "핵심개념",
  "교육내용",
  "현장사례",
  "안전유의사항",
  "안전수칙",
  "핵심요약",
  "정리",
  "마무리",
]);

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/gi, "");
}

/** 시스템 프롬프트에 실린 실제 참고 자료 라벨만 추출한다. */
export function extractSourceLabels(contextText: string): string[] {
  const labels = new Set<string>();
  const pattern = /(?:^|\n)(\[[^\[\]\r\n]{2,}\])(?=\r?\n)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contextText)) !== null) labels.add(match[1].trim());
  return Array.from(labels);
}

function report(issues: GenerationQualityIssue[]): GenerationQualityReport {
  return { ok: issues.length === 0, issues };
}

function findSection(
  sections: readonly GeneratedSection[],
  heading: string
): { section: GeneratedSection; index: number } | null {
  const index = sections.findIndex((section) => section.heading.trim() === heading);
  return index < 0 ? null : { section: sections[index], index };
}

function inspectSectionContract(
  sections: readonly GeneratedSection[],
  required: readonly string[],
  minChars: Readonly<Record<string, number>>
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  const allowed = new Set(required);

  required.forEach((heading, expectedIndex) => {
    const found = findSection(sections, heading);
    if (!found) {
      issues.push({
        code: "missing_section",
        path: "sections",
        message: `필수 섹션 '${heading}'이 없습니다.`,
      });
      return;
    }
    if (found.index !== expectedIndex) {
      issues.push({
        code: "section_order",
        path: `sections.${found.index}.heading`,
        message: `'${heading}' 섹션은 ${expectedIndex + 1}번째여야 합니다.`,
      });
    }
    const chars = compactText(found.section.content).length;
    const minimum = minChars[heading] ?? 1;
    if (chars < minimum) {
      issues.push({
        code: "thin_content",
        path: `sections.${found.index}.content`,
        message: `'${heading}' 내용이 ${chars}자로 너무 짧습니다. 근거 범위에서 최소 ${minimum}자 수준으로 구체화하세요.`,
      });
    }
  });

  sections.forEach((section, index) => {
    if (!allowed.has(section.heading.trim())) {
      issues.push({
        code: "unexpected_section",
        path: `sections.${index}.heading`,
        message: `허용되지 않은 섹션 '${section.heading}'이 있습니다.`,
      });
    }
  });
  return issues;
}

function bracketedMinutes(text: string): number[] {
  const values: number[] = [];
  // 출처 라벨의 수치가 아니라 [시간: 10분], [실습 · 15분 / 반복]처럼
  // 명시적인 단계 시간 표지만 합산한다.
  const pattern = /\[([^\]\n]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1].trim();
    if (/(?:p\.\s*\d+|출처|제한\s*시간)/i.test(body)) continue;
    const time = body.match(
      /(?:^시간\s*[:：]\s*|^[^\[\]\n]{1,50}?\s*[·•∙]\s*)(\d+)\s*(분|시간)(?=\s*(?:$|[\/|,;·•∙-]))/
    );
    if (!time) continue;
    const value = Number(time[1]);
    if (Number.isFinite(value) && value > 0) {
      values.push(time[2] === "시간" ? value * 60 : value);
    }
  }
  return values;
}

export function durationMinutes(duration: Duration): number {
  return duration === "1시간" ? 60 : duration === "2시간" ? 120 : 240;
}

function inspectTimeTotal(
  contents: readonly { content: string; path: string }[],
  duration: Duration
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  let total = 0;
  let markerCount = 0;

  for (const item of contents) {
    const times = bracketedMinutes(item.content);
    if (times.length === 0) {
      issues.push({
        code: "missing_time_allocation",
        path: item.path,
        message: "[시간: 00분] 또는 [단계명 · 00분] 형식의 시간 배분이 없습니다.",
      });
      continue;
    }
    markerCount += times.length;
    total += times.reduce((sum, minutes) => sum + minutes, 0);
  }

  const expected = durationMinutes(duration);
  if (markerCount > 0 && total !== expected) {
    issues.push({
      code: "time_total_mismatch",
      path: "sections",
      message: `표시된 시간 합계가 ${total}분입니다. 전체 교육 시간 ${expected}분과 일치시켜야 합니다.`,
    });
  }
  return issues;
}

function inspectSafetyContent(
  content: string,
  path: string
): GenerationQualityIssue[] {
  if (SAFETY_CUE.test(content) && STOP_OR_REPORT_CUE.test(content)) return [];
  return [
    {
      code: "missing_safety",
      path,
      message: "위험요소·예방조치와 훈련 중단 또는 보고 기준을 함께 구체화해야 합니다.",
    },
  ];
}

function inspectEvaluationContent(
  content: string,
  path: string
): GenerationQualityIssue[] {
  if (EVALUATION_CUE.test(content) && EVALUATION_STANDARD_CUE.test(content)) return [];
  return [
    {
      code: "missing_evaluation",
      path,
      message: "관찰 가능한 평가 방법과 통과·판단 기준을 함께 제시해야 합니다.",
    },
  ];
}

function inspectRequiredSourceCitations(
  sections: readonly GeneratedSection[],
  requiredHeadings: readonly string[],
  allowedSourceRefs?: readonly string[]
): GenerationQualityIssue[] {
  if (!allowedSourceRefs || allowedSourceRefs.length === 0) return [];

  const issues: GenerationQualityIssue[] = [];
  const allowed = new Set(allowedSourceRefs.map((sourceRef) => sourceRef.trim()));
  for (const heading of requiredHeadings) {
    const found = findSection(sections, heading);
    if (!found) continue;
    const refs = found.section.content.match(INLINE_SOURCE_REF)?.map((ref) => ref.trim()) ?? [];
    const matched = refs.filter((ref) => allowed.has(ref));
    if (matched.length === 0) {
      issues.push({
        code: "missing_source_citation",
        path: `sections.${found.index}.content`,
        message: `'${heading}'의 핵심 내용에 실제 참고 자료의 출처 라벨을 연결해야 합니다.`,
      });
    }
    refs
      .filter((ref) => /\bp\.(?:\d+|-)\b/i.test(ref) && !allowed.has(ref))
      .forEach((ref) => {
        issues.push({
          code: "invalid_source_ref",
          path: `sections.${found.index}.content`,
          message: `출처 '${ref}'는 현재 참고 자료에서 확인되지 않습니다.`,
        });
      });
  }
  return issues;
}

/** 훈련계획의 고정 5개 섹션, 충분한 분량, 시간 합계, 안전·평가 기준을 검사한다. */
export function inspectGeneratedPlan(
  draft: GeneratedDocDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[]
): GenerationQualityReport {
  const issues = inspectSectionContract(draft.sections, TRAINING_PLAN_SECTIONS, PLAN_MIN_CHARS);
  const training = findSection(draft.sections, "훈련내용");
  if (training) {
    issues.push(
      ...inspectTimeTotal(
        [{ content: training.section.content, path: `sections.${training.index}.content` }],
        duration
      )
    );
  }
  const safety = findSection(draft.sections, "안전관리");
  if (safety) {
    issues.push(...inspectSafetyContent(safety.section.content, `sections.${safety.index}.content`));
  }
  const evaluation = findSection(draft.sections, "훈련평가");
  if (evaluation) {
    issues.push(
      ...inspectEvaluationContent(
        evaluation.section.content,
        `sections.${evaluation.index}.content`
      )
    );
  }
  issues.push(
    ...inspectRequiredSourceCitations(
      draft.sections,
      ["훈련내용", "필요장비", "안전관리"],
      allowedSourceRefs
    )
  );
  return report(issues);
}

/** 교안의 실전 교육 흐름, 섹션별 분량, 단계별 시간, 안전·평가 기준을 검사한다. */
export function inspectGeneratedLesson(
  draft: GeneratedDocDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[]
): GenerationQualityReport {
  const issues = inspectSectionContract(draft.sections, LESSON_SECTIONS, LESSON_MIN_CHARS);
  const timedSections = LESSON_SECTIONS.slice(1)
    .map((heading) => findSection(draft.sections, heading))
    .filter((found): found is NonNullable<typeof found> => found !== null)
    .map((found) => ({
      content: found.section.content,
      path: `sections.${found.index}.content`,
    }));
  if (timedSections.length > 0) issues.push(...inspectTimeTotal(timedSections, duration));

  const safety = findSection(draft.sections, "안전유의사항");
  if (safety) {
    issues.push(...inspectSafetyContent(safety.section.content, `sections.${safety.index}.content`));
  }
  const evaluation = findSection(draft.sections, "정리·평가");
  if (evaluation) {
    issues.push(
      ...inspectEvaluationContent(
        evaluation.section.content,
        `sections.${evaluation.index}.content`
      )
    );
  }
  issues.push(
    ...inspectRequiredSourceCitations(
      draft.sections,
      ["핵심이론", "교관시범", "안전유의사항"],
      allowedSourceRefs
    )
  );
  return report(issues);
}

/** 슬라이드 수, 화면 내용, 교관 노트, 출처, 의미 레이아웃, 안전·평가 장, 중복을 검사한다. */
export function inspectGeneratedSlides(
  draft: GeneratedSlideDeckDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[]
): GenerationQualityReport {
  const issues: GenerationQualityIssue[] = [];
  const [minimum, maximum] = slideCountRangeFor(duration);
  if (draft.slides.length < minimum || draft.slides.length > maximum) {
    issues.push({
      code: "slide_count",
      path: "slides",
      message: `${duration} 교육은 본문 슬라이드 ${minimum}~${maximum}장이 필요하지만 ${draft.slides.length}장입니다.`,
    });
  }

  const titleAt = new Map<string, number>();
  const contentAt = new Map<string, number>();
  let hasSafety = false;
  let hasEvaluation = false;
  const allowedSources =
    allowedSourceRefs && allowedSourceRefs.length > 0
      ? new Set(allowedSourceRefs.map((sourceRef) => sourceRef.trim()))
      : null;

  draft.slides.forEach((slide, index) => {
    const titleKey = normalizedKey(slide.title);
    const contentKey = normalizedKey(slide.bullets.join(" "));
    const slideText = `${slide.title} ${slide.bullets.join(" ")} ${slide.notes}`;

    if (titleAt.has(titleKey)) {
      issues.push({
        code: "duplicate_slide_title",
        path: `slides.${index}.title`,
        message: `${(titleAt.get(titleKey) ?? 0) + 1}번째 슬라이드와 제목이 중복됩니다.`,
      });
    } else if (titleKey) {
      titleAt.set(titleKey, index);
    }
    if (contentAt.has(contentKey)) {
      issues.push({
        code: "duplicate_slide_content",
        path: `slides.${index}.bullets`,
        message: `${(contentAt.get(contentKey) ?? 0) + 1}번째 슬라이드와 핵심 내용이 중복됩니다.`,
      });
    } else if (contentKey) {
      contentAt.set(contentKey, index);
    }

    const bulletChars = compactText(slide.bullets.join(" ")).length;
    if (slide.bullets.length < 2 || bulletChars < 45) {
      issues.push({
        code: "thin_content",
        path: `slides.${index}.bullets`,
        message: `화면 내용이 ${bulletChars}자로 너무 짧습니다. 서로 다른 구체적 핵심 문장 2~4개가 필요합니다.`,
      });
    }
    const titleChars = compactText(slide.title).length;
    if (titleChars > MAX_SLIDE_TITLE_CHARS) {
      issues.push({
        code: "slide_title_too_long",
        path: `slides.${index}.title`,
        message: `제목이 ${titleChars}자로 깁니다. 결론은 유지하면서 ${MAX_SLIDE_TITLE_CHARS}자 이내로 줄이세요.`,
      });
    }
    slide.bullets.forEach((bullet, bulletIndex) => {
      const chars = compactText(bullet).length;
      if (chars <= MAX_SLIDE_BULLET_CHARS) return;
      issues.push({
        code: "slide_bullet_too_long",
        path: `slides.${index}.bullets.${bulletIndex}`,
        message: `핵심 문장이 ${chars}자로 깁니다. 의미와 출처는 유지하면서 ${MAX_SLIDE_BULLET_CHARS}자 이내로 줄이세요.`,
      });
    });
    slide.steps?.forEach((step, stepIndex) => {
      const chars = compactText(step).length;
      if (chars <= MAX_SLIDE_STEP_CHARS) return;
      issues.push({
        code: "slide_step_too_long",
        path: `slides.${index}.steps.${stepIndex}`,
        message: `단계어가 ${chars}자로 깁니다. 순서의 핵심만 ${MAX_SLIDE_STEP_CHARS}자 이내로 줄이세요.`,
      });
    });
    const noteChars = compactText(slide.notes).length;
    if (noteChars < MIN_SLIDE_NOTES_CHARS) {
      issues.push({
        code: "thin_notes",
        path: `slides.${index}.notes`,
        message: `발표자 노트가 ${noteChars}자로 짧습니다. 최소 ${MIN_SLIDE_NOTES_CHARS}자 수준의 설명 대본이 필요합니다.`,
      });
    }
    if (!slide.layout) {
      issues.push({
        code: "missing_slide_layout",
        path: `slides.${index}.layout`,
        message: "내용 의미에 맞는 layout을 지정해야 합니다.",
      });
    }
    if (GENERIC_SLIDE_TITLES.has(titleKey)) {
      issues.push({
        code: "generic_slide_title",
        path: `slides.${index}.title`,
        message: "분류형 제목 대신 이 장의 결론이 드러나는 서술형 제목을 사용하세요.",
      });
    }
    if (!slide.sourceRefs || slide.sourceRefs.length === 0) {
      issues.push({
        code: "missing_source_refs",
        path: `slides.${index}.sourceRefs`,
        message: "이 슬라이드의 근거 출처 라벨을 1개 이상 연결해야 합니다.",
      });
    } else {
      slide.sourceRefs.forEach((sourceRef, sourceIndex) => {
        const normalizedRef = sourceRef.trim();
        if (!SOURCE_REF_FORMAT.test(normalizedRef) || (allowedSources && !allowedSources.has(normalizedRef))) {
          issues.push({
            code: "invalid_source_ref",
            path: `slides.${index}.sourceRefs.${sourceIndex}`,
            message: `출처 '${sourceRef}'는 현재 참고 자료에 표시된 라벨과 정확히 일치해야 합니다.`,
          });
        }
      });
    }

    if (slide.layout === "safety" || (SAFETY_CUE.test(slideText) && STOP_OR_REPORT_CUE.test(slideText))) {
      hasSafety = true;
    }
    if (slide.layout === "summary" && EVALUATION_CUE.test(slideText)) hasEvaluation = true;
  });

  if (!hasSafety) {
    issues.push({
      code: "missing_safety",
      path: "slides",
      message: "위험요소와 중단·보고 기준을 다루는 안전 슬라이드가 필요합니다.",
    });
  }
  if (!hasEvaluation) {
    issues.push({
      code: "missing_evaluation",
      path: "slides",
      message: "핵심 확인 질문 또는 수행평가 기준을 담은 요약 슬라이드가 필요합니다.",
    });
  }
  return report(issues);
}

export function inspectGenerationQuality(
  type: "plan" | "lesson" | "slides",
  draft: GeneratedDocDraft | GeneratedSlideDeckDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[]
): GenerationQualityReport {
  if (type === "slides") {
    return inspectGeneratedSlides(draft as GeneratedSlideDeckDraft, duration, allowedSourceRefs);
  }
  if (type === "plan") {
    return inspectGeneratedPlan(draft as GeneratedDocDraft, duration, allowedSourceRefs);
  }
  return inspectGeneratedLesson(draft as GeneratedDocDraft, duration, allowedSourceRefs);
}

/** API 응답·저장본이 보관한 실제 출처 라벨을 사용해 사용자 편집본을 다시 검사한다. */
export function inspectCurrentGenerationQuality(
  type: "plan" | "lesson" | "slides",
  draft: GeneratedDoc | GeneratedSlideDeck,
  duration: Duration
): GenerationQualityReport {
  const checked = inspectGenerationQuality(type, draft, duration, draft.sourceLabels);
  if (draft.sourceLabels && draft.sourceLabels.length > 0) return checked;
  return report([
    ...checked.issues,
    {
      code: "source_validation_unavailable",
      path: "sourceLabels",
      message:
        "이 저장본에는 생성 당시 허용 출처 목록이 없어 인용의 진위를 완전히 재검증할 수 없습니다.",
    },
  ]);
}

export function buildGenerationRepairPrompt(args: {
  type: "plan" | "lesson" | "slides";
  request: Pick<
    GenerateRequest,
    "category" | "audience" | "duration" | "topic" | "conditions"
  >;
  draft: GeneratedDocDraft | GeneratedSlideDeckDraft;
  report: GenerationQualityReport;
}): string {
  if (args.report.ok || args.report.issues.length === 0) {
    throw new Error("수정할 품질 문제가 없습니다.");
  }
  const issueLines = args.report.issues
    .map((issue, index) => `${index + 1}. [${issue.code}] ${issue.path}: ${issue.message}`)
    .join("\n");
  const structure =
    args.type === "plan"
      ? `sections는 ${TRAINING_PLAN_SECTIONS.join(" → ")}의 정확히 5개를 같은 순서로 유지하세요.`
      : args.type === "lesson"
        ? `sections는 ${LESSON_SECTIONS.join(" → ")}의 정확히 7개를 같은 순서로 유지하세요.`
        : `본문 슬라이드는 ${slideCountFor(args.request.duration)}장으로 맞추고, 모든 장에 layout과 sourceRefs를 넣으세요. 제목은 ${MAX_SLIDE_TITLE_CHARS}자, 각 핵심 문장은 ${MAX_SLIDE_BULLET_CHARS}자, 각 단계어는 ${MAX_SLIDE_STEP_CHARS}자 이내로 다듬으세요.`;
  const condition = conditionPromptParts(args.request.conditions);

  return `아래 ${args.type === "plan" ? "훈련계획" : args.type === "lesson" ? "교안" : "슬라이드"} 초안을 품질 검사 결과에 따라 전체 수정하세요.

[요청 조건]
- 분야: ${args.request.category}
- 대상: ${args.request.audience}
- 교육 시간: ${args.request.duration}
- 주제: ${args.request.topic?.trim() || "분야 핵심 주제"}
${condition.line.trimStart()}

[반드시 고칠 문제]
${issueLines}

[수정 원칙]
- ${structure}
- ${condition.rule}
- 시스템 프롬프트의 [참고 자료]에 있는 내용만 사용하세요. 분량을 채우려고 일반 상식·수치·절차·사례를 만들지 마세요.
- 초안에 이미 있는 근거 있는 내용은 보존하되, 중복을 제거하고 교관·대원의 실제 행동과 평가 기준을 구체화하세요.
- 출처 라벨은 [참고 자료]에 표시된 문자열만 그대로 사용하세요. 확인할 수 없는 내용은 "참고 자료에서 확인되지 않습니다"라고 쓰세요.
- 검사에서 지적하지 않은 항목도 앞뒤 흐름과 대상 수준이 자연스럽도록 함께 다듬으세요.
- 설명이나 코드블록 없이, 요청 유형의 전체 JSON 객체만 반환하세요.

[수정할 초안]
${JSON.stringify(args.draft, null, 2)}`;
}

// ── 저장된 생성물 (이력) ──
// content 는 kind 에 따라 { sections, sources } | { slides, sources } | { prompt } 형태.
export type SavedMaterial = {
  id: number;
  kind: GenType;
  category: string | null;
  audience: string | null;
  duration: string | null;
  topic: string | null;
  title: string;
  content: unknown;
  shared?: boolean;
  author_name?: string | null;
  created_at: string;
};

// ── 부분 재생성 (섹션/슬라이드 1개) ──
export const regeneratedSectionSchema = z.object({
  heading: z.string().describe("섹션 제목 (번호 포함, 예: '3. 단계별 진행')"),
  content: z.string().describe("섹션 본문. 줄바꿈(\\n)으로 항목 구분"),
});

export const regeneratedSlideSchema = generatedSlideSchema;

// 부분 재생성 지시(프리셋) — 클라이언트가 보내는 자연어 지시. 직접 입력도 허용.
export const REGEN_INSTRUCTIONS = [
  { key: "detail", label: "더 자세히", text: "내용을 더 구체적이고 자세하게, 단계와 수치를 보강해 작성" },
  { key: "concise", label: "더 간결히", text: "핵심만 남겨 더 간결하고 명확하게 작성" },
  { key: "example", label: "현장 사례 추가", text: "현장 적용 사례나 예시를 포함해 작성" },
] as const;

// 섹션 1개 재생성 프롬프트 — 전체 구성(outline) 안에서 해당 섹션만 다시 쓴다.
export function buildSectionRegenPrompt(args: {
  category: string;
  audience: Audience;
  duration: Duration;
  docTitle: string;
  outline: string[];
  index: number;
  currentHeading: string;
  currentContent: string;
  conditions?: string;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  const condition = conditionPromptParts(args.conditions);
  return `전북소방본부 ${args.category} 분야 교육 문서 "${args.docTitle}"의 한 섹션만 다시 작성합니다.

[문서 전체 구성]
${outlineText}

[다시 작성할 섹션] ${args.index + 1}번째 — "${args.currentHeading}"
[요청 조건]${condition.line}
[현재 내용]
${args.currentContent}${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 다른 섹션과 중복되지 않게, 이 섹션의 역할에 충실하게 작성하세요.
- 대상 수준(${args.audience})·교육 시간(${args.duration})에 맞춰 한국어로 작성하세요.
- heading은 반드시 현재 제목 "${args.currentHeading}"을 글자 그대로 유지하세요.
- 이 섹션 하나만 JSON으로 반환하세요(heading, content).`;
}

// 슬라이드 1개 재생성 프롬프트 — 전체 슬라이드 구성 안에서 해당 1장만 다시 쓴다.
export function buildSlideRegenPrompt(args: {
  category: string;
  audience: Audience;
  duration: Duration;
  deckTitle: string;
  outline: string[];
  index: number;
  current: GeneratedSlide;
  conditions?: string;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  const condition = conditionPromptParts(args.conditions);
  return `전북소방본부 ${args.category} 분야 발표 "${args.deckTitle}"의 슬라이드 한 장만 다시 작성합니다.

[발표 전체 구성]
${outlineText}

[다시 작성할 슬라이드] ${args.index + 1}번째 — "${args.current.title}"
[요청 조건]${condition.line}
[현재 내용]
${args.current.bullets.map((b) => `· ${b}`).join("\n")}
(노트: ${args.current.notes})${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 다른 슬라이드와 중복되지 않게 작성하세요.
- 제목은 분류명이 아니라 이 장의 결론이 드러나는 서술형으로 ${MAX_SLIDE_TITLE_CHARS}자 이내로 쓰고, 핵심 문장은 구체적으로 2~4개를 각각 ${MAX_SLIDE_BULLET_CHARS}자 이내로 작성하세요.
- 발표자 노트는 이유·시범 포인트·질문·흔한 실수 중 해당 내용을 포함해 4~7문장으로 작성하세요.
- 절차·흐름 슬라이드면 steps 에 ${MAX_SLIDE_STEP_CHARS}자 이내의 단계어 3~5개를 넣고, 아니면 steps 를 생략하세요.
- 내용 의미에 맞는 layout을 지정하고, sourceRefs에는 참고 자료의 출처 라벨을 글자 그대로 1~4개 넣으세요.
- 참고 자료에 없는 출처 라벨이나 주장을 만들지 마세요.
- 대상 수준(${args.audience})에 맞는 용어로 한국어로, 이 슬라이드 하나만 JSON으로 반환하세요.`;
}

// NotebookLM에 붙여넣는 프롬프트 — AI 호출 없이 조립(데모·내부망에서도 동일 동작).
// docTitles: 인덱싱(벡터DB)된 해당 분야 자료 제목 — 어떤 자료를 업로드할지 안내에 포함.
export function buildNotebookLmPrompt(
  req: GenerateRequest,
  docTitles: string[] = []
): string {
  const topic = req.topic?.trim() || `${req.category} 분야 핵심 주제`;
  const condition = conditionPromptParts(req.conditions);
  const materials =
    docTitles.length > 0
      ? `\n\n업로드할 자료 (플랫폼에 인덱싱된 ${req.category} 분야 자료):\n${docTitles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "";
  return `업로드한 전북소방 ${req.category} 분야 교육자료를 바탕으로 "${topic}" 교육용 슬라이드를 만들어 주세요.${materials}

조건:
- 대상: ${req.audience} (이 수준에 맞는 용어와 난이도로)
- 교육 시간: ${req.duration} 분량 (슬라이드 ${
    req.duration === "1시간" ? "10~15" : req.duration === "2시간" ? "20~25" : "30~40"
  }장)${condition.line}
- ${condition.rule}
- 구성: ① 학습 목표 1장 ② 핵심 개념·절차 (단계별로 1장씩, 그림 위치 표시) ③ 현장 적용 사례 ④ 안전 유의사항 ⑤ 핵심 요약·퀴즈 1장
- 각 슬라이드: 제목 + 핵심 문장 3개 이하 + 발표자 노트(설명 대본)
- 자료에 없는 내용은 넣지 말고, 각 슬라이드에 근거 자료의 쪽 번호를 표시해 주세요.
- 전북소방본부 교육용이므로 격식 있는 한국어로 작성해 주세요.`;
}
