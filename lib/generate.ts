// 교육자료·훈련계획 생성 — 스키마·옵션·프롬프트의 단일 출처.
// UI는 클릭·선택형(자유 입력 최소화): 유형 × 분야 × 대상 × 시간 조합으로 생성한다.
import { z } from "zod";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
  inspectSopContract,
  type SopEvidence,
  type SopQualityIssueCode,
} from "@/lib/sop-evidence";

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
  /** 슬라이드 화면 밀도. 과거 클라이언트는 생략하며 발표형으로 처리한다. */
  slideMode?: SlideDeckMode;
  topic?: string; // 선택: 훈련 내용/주제(예: "공기호흡기 점검")
  /** 넓은 상위 주제 안에서 이번 결과가 집중할 구체적인 훈련 방향. */
  focus?: string;
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
  content: z
    .string()
    .describe("섹션 본문. 줄바꿈(\\n)으로 항목을 구분하고 출처 라벨은 본문에 적지 않음"),
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

/**
 * 화면에는 출처가 지나치게 길게 보이지 않도록 일부만 노출하되, 원문 시각자료 바인딩에는
 * 회수한 모든 문서·페이지 메타데이터를 사용한다.
 */
export function splitGeneratedSourcesForDisplay(
  candidates: readonly GeneratedDocSource[],
  displayLimit = 5
): { sources: GeneratedDocSource[]; bindingSources: GeneratedDocSource[] } {
  const unique = new Map<string, GeneratedDocSource>();
  for (const source of candidates) {
    if (
      !Number.isInteger(source.document_id) ||
      !source.doc.trim() ||
      (source.page !== null && !Number.isInteger(source.page))
    ) {
      continue;
    }
    const normalized: GeneratedDocSource = {
      document_id: source.document_id,
      doc: source.doc.trim(),
      page: source.page,
    };
    const key = `${normalized.document_id}::${normalized.page ?? "-"}::${normalized.doc}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  const bindingSources = Array.from(unique.values());
  const limit = Math.max(0, Math.floor(displayLimit));
  return { sources: bindingSources.slice(0, limit), bindingSources };
}

export type GeneratedDoc = {
  title: string;
  sections: GeneratedSection[];
  sources: GeneratedDocSource[];
  /** 생성 당시 RAG 컨텍스트에서 허용된 정확한 출처 라벨. 편집 후 재검사용. */
  sourceLabels?: string[];
  /** 일반 교재와 분리해 검증한 SOP·현장지침 근거 상태. */
  sopEvidence?: SopEvidence;
};

// ── 슬라이드(PPTX) 생성 결과 ──
export const SLIDE_DECK_MODES = ["presenter", "detailed"] as const;
export type SlideDeckMode = (typeof SLIDE_DECK_MODES)[number];
// 과거 저장본은 발표형으로 복원하되, 신규 현장교육 자료는 화면만 읽어도 이해되는 상세형을 권장한다.
export const DEFAULT_SLIDE_DECK_MODE: SlideDeckMode = "presenter";
export const RECOMMENDED_SLIDE_DECK_MODE: SlideDeckMode = "detailed";

/**
 * role은 이 장이 교육 흐름에서 맡는 역할이고, composition은 화면의 시각 구도다.
 * 둘을 분리해야 같은 안전 장도 체크리스트·판단 흐름·원문 설명 등으로 다르게 표현할 수 있다.
 */
export const SLIDE_ROLE_TYPES = [
  "objectives",
  "concept",
  "procedure",
  "equipment",
  "comparison",
  "timeline",
  "decision",
  "case",
  "safety",
  "evidence",
  "summary",
] as const;
export type SlideRoleType = (typeof SLIDE_ROLE_TYPES)[number];

export const SLIDE_COMPOSITION_TYPES = [
  "statement",
  "list",
  "process",
  "comparison",
  "timeline",
  "decision-flow",
  "checklist",
  "scenario",
  "visual-explanation",
  "summary",
] as const;
export type SlideCompositionType = (typeof SLIDE_COMPOSITION_TYPES)[number];

export const SLIDE_VISUAL_MODES = [
  "source-page",
  "source-crop",
  "native-diagram",
  "none",
] as const;
export type SlideVisualMode = (typeof SLIDE_VISUAL_MODES)[number];
export const SLIDE_VISUAL_FITS = ["contain", "cover"] as const;
export type SlideVisualFit = (typeof SLIDE_VISUAL_FITS)[number];

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

const generatedSlideVisualMetadataSchema = z.object({
  mode: z
    .enum(SLIDE_VISUAL_MODES)
    .describe("원문 시각자료, 기본 도형 다이어그램 또는 시각자료 없음"),
  assetId: z
    .string()
    .max(200)
    .optional()
    .describe("서버가 연결한 시각자료 식별자. 모델이 임의로 만들지 않음"),
  documentId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("서버가 검증한 원문 자료 ID. 모델이 임의로 만들지 않음"),
  page: z.number().int().positive().optional().describe("원문 자료의 1부터 시작하는 페이지"),
  sourceRef: z
    .string()
    .max(300)
    .optional()
    .describe("참고 자료에 표시된 정확한 출처 라벨"),
  altText: z
    .string()
    .max(300)
    .optional()
    .describe("시각자료가 전달하는 내용을 설명하는 대체 텍스트"),
  caption: z.string().max(200).optional().describe("시각자료 아래 짧은 설명"),
  fit: z.enum(SLIDE_VISUAL_FITS).optional().describe("이미지 맞춤: 전체 표시 또는 채우기"),
});

export type GeneratedSlideVisualMetadata = z.infer<
  typeof generatedSlideVisualMetadataSchema
>;

/** 브라우저가 원문 페이지를 렌더한 뒤 PPTX 다운로드 직전에만 주입하는 런타임 값. */
export type GeneratedSlideVisual = GeneratedSlideVisualMetadata & {
  imageData?: string;
};

export const generatedSlideSchema = z.object({
  title: z
    .string()
    .describe("이 장에서 기억할 결론이 드러나는 서술형 제목 (25자 내외)"),
  bullets: z
    .array(z.string().describe("근거가 있는 구체적 핵심 문장 (한 줄, 55자 내외)"))
    .min(1)
    .max(4),
  steps: z
    .array(z.string().describe("단계 핵심어 (짧게, 10자 내외)"))
    .min(2)
    .max(5)
    .optional()
    .describe(
      "비교는 두 기준명, 절차·시간흐름·판단흐름은 순서대로 3~5개 단계어"
    ),
  notes: z
    .string()
    .describe("교관이 그대로 활용할 수 있는 설명 대본. 근거·시범 포인트·질문을 포함한 4~7문장"),
  layout: z
    .enum(SLIDE_LAYOUT_TYPES)
    .optional()
    .describe("내용 의미에 맞는 레이아웃 유형. 과거 저장본 호환을 위해 선택 필드"),
  role: z
    .enum(SLIDE_ROLE_TYPES)
    .optional()
    .describe("교육 흐름에서 이 장이 맡는 의미 역할. 과거 저장본 호환을 위해 선택 필드"),
  composition: z
    .enum(SLIDE_COMPOSITION_TYPES)
    .optional()
    .describe("PPTX 화면에 내용을 배치하는 시각 구도. role과 별도로 선택"),
  visual: generatedSlideVisualMetadataSchema
    .optional()
    .describe("원문 시각자료 또는 기본 도형 다이어그램에 대한 안전한 메타데이터"),
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
  mode: z
    .enum(SLIDE_DECK_MODES)
    .optional()
    .describe("발표형(presenter) 또는 스스로 읽는 상세형(detailed)"),
  slides: z.array(generatedSlideSchema).min(6).max(20),
});

/**
 * 신규 전체 생성·부분 재생성에서만 사용할 엄격한 슬라이드 스키마.
 *
 * `generatedSlideSchema`의 optional `sourceRefs`는 과거 저장본 호환을 위해
 * 유지하되, LLM 신규 출력은 서버가 재조회한 허용 라벨만 1~4개
 * 반드시 넣도록 동적 enum으로 제한한다.
 */
export function strictGeneratedSlideSchemaFor(
  allowedSourceLabels: readonly string[]
) {
  const labels = Array.from(
    new Set(
      allowedSourceLabels
        .map((label) => label.trim())
        .filter(
          (label) =>
            label.length >= 4 &&
            label.length <= 300 &&
            label.startsWith("[") &&
            label.endsWith("]") &&
            !/[\r\n]/.test(label)
        )
    )
  ).slice(0, 80);
  if (labels.length === 0) {
    throw new Error("슬라이드 생성에 사용할 검증된 출처 라벨이 없습니다.");
  }
  const allowedLabelSchema = z.enum(labels as [string, ...string[]]);
  return generatedSlideSchema.extend({
    // 모델이 지시를 벗어나 과도한 본문을 반환해도 durable checkpoint 1 MiB를
    // 잠식하지 않도록, 정상 교관용 분량보다 충분히 넓은 저장 안전 상한을 둔다.
    title: z.string().min(2).max(100),
    bullets: z.array(z.string().min(1).max(500)).min(1).max(4),
    steps: z.array(z.string().min(1).max(100)).min(2).max(5).optional(),
    notes: z.string().min(1).max(5_000),
    sourceRefs: z
      .array(allowedLabelSchema)
      .min(1)
      .max(4)
      .describe("서버가 허용한 정확한 출처 라벨 1~4개. 임의 라벨 생성 금지"),
  });
}

/** 신규 전체 PPT 생성용. 덱의 모든 장에 검증된 sourceRefs를 강제한다. */
export function strictGeneratedSlidesSchemaFor(
  allowedSourceLabels: readonly string[]
) {
  return generatedSlidesSchema.extend({
    title: z.string().min(2).max(100),
    slides: z.array(strictGeneratedSlideSchemaFor(allowedSourceLabels)).min(6).max(20),
  });
}

type GeneratedSlideSchemaOutput = z.infer<typeof generatedSlideSchema>;
export type GeneratedSlide = Omit<GeneratedSlideSchemaOutput, "visual"> & {
  visual?: GeneratedSlideVisual;
};

export type GeneratedSlideDeck = {
  title: string;
  /** 생략된 과거 저장본은 DEFAULT_SLIDE_DECK_MODE로 해석한다. */
  mode?: SlideDeckMode;
  slides: GeneratedSlide[];
  sources: GeneratedDocSource[];
  /** 생성 당시 RAG 컨텍스트에서 허용된 정확한 출처 라벨. 편집 후 재검사용. */
  sourceLabels?: string[];
  /** 일반 교재와 분리해 검증한 SOP·현장지침 근거 상태. */
  sopEvidence?: SopEvidence;
};

export function resolveSlideDeckMode(value: unknown): SlideDeckMode {
  return SLIDE_DECK_MODES.includes(value as SlideDeckMode)
    ? (value as SlideDeckMode)
    : DEFAULT_SLIDE_DECK_MODE;
}

/** 검증된 문서 메타데이터를 생성 프롬프트와 같은 정확한 인용 라벨로 바꾼다. */
export function generatedSourceLabel(source: GeneratedDocSource): string {
  return `[${source.doc.trim()}${source.page != null ? ` p.${source.page}` : ""}]`;
}

/** macOS 파일명의 NFD와 브라우저·LLM의 NFC 표기를 같은 출처 라벨로 비교한다. */
export function normalizedSourceLabelKey(label: string): string {
  return label.trim().normalize("NFC");
}

/** 서버가 확인한 출처만으로 저장·재검사용 허용 라벨 목록을 재구성한다. */
export function generatedSourceLabels(
  sources: readonly GeneratedDocSource[]
): string[] {
  const labels = new Set<string>();
  for (const source of sources) {
    if (
      !Number.isSafeInteger(source.document_id) ||
      source.document_id <= 0 ||
      !source.doc.trim() ||
      (source.page !== null &&
        (!Number.isSafeInteger(source.page) || (source.page ?? 0) <= 0))
    ) {
      continue;
    }
    labels.add(generatedSourceLabel(source));
    if (labels.size >= 80) break;
  }
  return Array.from(labels);
}

export function fallbackSlideVisualMode(slide: GeneratedSlide): SlideVisualMode {
  return slide.composition === "process" ||
    slide.composition === "comparison" ||
    slide.composition === "timeline" ||
    slide.composition === "decision-flow" ||
    slide.composition === "checklist"
    ? "native-diagram"
    : "none";
}

/**
 * LLM이 적은 ID를 신뢰하지 않고 실제 검색 결과의 정확한 출처 라벨로만 원문 페이지를 연결한다.
 * 원문 ID·페이지를 검증할 수 없으면 외부 이미지를 요청하지 않는 안전한 구도로 내린다.
 */
export function bindSlideVisualsToSources(
  draft: GeneratedSlideDeckDraft,
  sources: readonly GeneratedDocSource[],
  options: { rejectMismatchedMetadata?: boolean } = {}
): GeneratedSlideDeckDraft {
  const sourceByLabel = new Map<string, GeneratedDocSource>();
  const ambiguousLabels = new Set<string>();
  const documentIdsByLabel = new Map<string, Set<number>>();
  for (const source of sources) {
    if (
      !Number.isInteger(source.document_id) ||
      !source.doc.trim() ||
      source.page == null ||
      !Number.isInteger(source.page) ||
      source.page <= 0
    ) {
      continue;
    }
    const label = normalizedSourceLabelKey(generatedSourceLabel(source));
    const ids = documentIdsByLabel.get(label) ?? new Set<number>();
    ids.add(source.document_id);
    documentIdsByLabel.set(label, ids);
    if (ids.size > 1) ambiguousLabels.add(label);
  }
  for (const source of sources) {
    if (
      !Number.isInteger(source.document_id) ||
      source.document_id <= 0 ||
      !source.doc.trim() ||
      source.page == null ||
      !Number.isInteger(source.page) ||
      source.page <= 0
    ) {
      continue;
    }
    const label = normalizedSourceLabelKey(generatedSourceLabel(source));
    if (!ambiguousLabels.has(label) && !sourceByLabel.has(label)) {
      sourceByLabel.set(label, source);
    }
  }

  return {
    ...draft,
    slides: draft.slides.map((slide) => {
      const visual = slide.visual;
      if (!visual || (visual.mode !== "source-page" && visual.mode !== "source-crop")) {
        if (!visual) return { ...slide };
        return {
          ...slide,
          visual: {
            mode: visual.mode,
            sourceRef: visual.sourceRef,
            altText: visual.altText,
            caption: visual.caption,
            fit: visual.fit,
          },
        };
      }

      const sourceRef = visual.sourceRef?.trim();
      const sourceRefKey = sourceRef ? normalizedSourceLabelKey(sourceRef) : "";
      const source =
        slide.composition === "visual-explanation" &&
        sourceRefKey &&
        !ambiguousLabels.has(sourceRefKey)
          ? sourceByLabel.get(sourceRefKey)
          : undefined;
      const mismatchedMetadata =
        source &&
        ((visual.documentId !== undefined && visual.documentId !== source.document_id) ||
          (visual.page !== undefined && visual.page !== source.page));
      if (
        !source ||
        !sourceRef ||
        (options.rejectMismatchedMetadata === true && mismatchedMetadata)
      ) {
        return {
          ...slide,
          visual: {
            mode: fallbackSlideVisualMode(slide),
            altText: visual.altText,
            caption: visual.caption,
          },
        };
      }

      return {
        ...slide,
        visual: {
          // 현재 브라우저 렌더러는 안전한 전체 페이지 삽입만 지원한다.
          mode: "source-page",
          documentId: source.document_id,
          page: source.page ?? undefined,
          sourceRef: generatedSourceLabel(source),
          altText: visual.altText,
          caption: visual.caption,
          fit: visual.fit ?? "contain",
        },
      };
    }),
  };
}

// ── 시스템 프롬프트 (단일 출처) ──
// route.ts(전체 생성)·section/route.ts(부분 재생성)가 공유한다.
// 교관 페르소나 + 근거(RAG) 규칙 + 품질/표현 기준을 담아 결과물 수준을 높인다.
// 인용 자료(contextText)는 항상 마지막에 붙여 "이 자료 = 유일한 근거"임을 명확히 한다.
function normalizedSopEvidence(evidence?: SopEvidence): SopEvidence {
  if (!evidence) return { status: "not_found", sourceLabels: [] };
  return {
    status: evidence.status,
    sourceLabels: Array.from(
      new Set(evidence.sourceLabels.map((label) => label.trim()).filter(Boolean))
    ),
  };
}

export function buildSopPromptContract(evidence?: SopEvidence): string {
  const safe = normalizedSopEvidence(evidence);
  if (safe.status === "found") {
    return `[SOP·표준절차 적용 계약]
- 생성 결과의 지정 위치에 소제목 ${SOP_APPLICATION_MARKER}을 정확히 넣습니다.
- SOP·현장지침의 명칭·순서·역할·중단·보고 기준은 아래 허용 SOP 출처에서 직접 확인되는 범위만 씁니다.
- 훈련계획·교안은 본문에 출처 라벨을 쓰지 않고 문서 맨 뒤의 '근거 자료 및 출처' 목록에만 서버가 자동으로 모읍니다. 슬라이드는 적용 장의 sourceRefs에 연결합니다.
- 서버가 연결할 수 있는 허용 SOP 출처는 다음과 같습니다.
${safe.sourceLabels.map((label) => `  · ${label}`).join("\n")}
- 일반 교육자료의 출처는 SOP 근거로 대신하지 않습니다.`;
  }
  if (safe.status === "degraded") {
    return `[SOP·표준절차 적용 계약]
- 지정 위치에 다음 문장을 글자 하나 바꾸지 않고 넣습니다.
  ${SOP_DEGRADED_DISCLOSURE}
- SOP 번호·명칭·절차를 추정하거나 일반 교재의 내용을 SOP라고 단정하지 않습니다.`;
  }
  return `[SOP·표준절차 적용 계약]
- 지정 위치에 다음 문장을 글자 하나 바꾸지 않고 넣습니다.
  ${SOP_NOT_FOUND_DISCLOSURE}
- SOP 번호·명칭·절차를 추정하거나 일반 교재의 내용을 SOP라고 단정하지 않습니다.`;
}

export function buildGenerateSystemPrompt(
  category: string,
  contextText: string,
  sopEvidence?: SopEvidence
): string {
  return `당신은 전북소방본부의 ${category} 분야 교육훈련을 20년간 맡아 온 베테랑 교관이자 교육기획 담당관입니다.
현장 대원이 그대로 사용할 수 있는, 정확하고 실전적인 교육 문서를 작성합니다.

[근거 규칙 — 가장 중요]
- 아래 [참고 자료]에 있는 내용만 근거로 작성합니다. 자료에 없는 절차·수치·장비명·규정을 지어내지 마세요.
- 참고 자료가 특정 항목을 다루지 않으면, 억지로 채우지 말고 자료에 담긴 범위 안에서 충실히 구성합니다.
- 일반 상식이나 타 기관 기준을 임의로 끌어오지 않습니다. 근거는 오직 이 자료입니다.
- 참고 자료에 없는 내용은 "참고 자료에서 확인되지 않습니다"라고 명시합니다. 분량을 늘리기 위해 추측하지 않습니다.
- 훈련계획·교안은 본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 붙이지 않습니다. 검증된 출처는 서버가 문서 맨 뒤의 '근거 자료 및 출처' 목록으로 자동 구성합니다.
- 슬라이드는 각 장의 sourceRefs에만 참고 자료에 표시된 라벨을 글자 하나 바꾸지 않고 적습니다(예: [문서명 p.3]).
- 출처 라벨만으로 뒷받침되지 않는 새로운 주장·수치·절차를 추가하지 않습니다.

[기술 사실과 훈련 가정의 경계]
- 장비 사양·절차 순서·수치·위험성·중단 기준·SOP처럼 현장에서 사실로 받아들일 내용은 반드시 참고 자료에서 확인된 범위만 씁니다.
- 교육을 구체화하기 위한 상황 부여·역할 교대·질문·반복·피드백 방식은 만들 수 있지만, 참고 자료나 사용자 조건에 없는 현장 설정은 문장 앞에 "훈련 가정:"이라고 표시합니다.
- 훈련 가정에는 새로운 기술 절차·장비 수량·안전 수치·SOP 명칭을 넣지 않으며 실제 현장 기준인 것처럼 단정하지 않습니다.
- 구체화는 분량을 늘리는 것이 아니라 상황 → 판단 조건 → 행동 → 확인 → 실수 교정 → 평가가 이어지게 하는 것입니다.
- 참고 자료에 고정된 행동 순서가 있으면 그 순서를 보존합니다. 고정 순서가 확인되지 않으면 기술 절차를 임의로 만들지 말고, 교육 진행을 위한 순서임을 밝힌 뒤 판단 조건 → 관찰 가능한 행동 → 결과 확인 → 보고 흐름으로 작성합니다.

${buildSopPromptContract(sopEvidence)}

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

function slideModePromptParts(value: unknown): { mode: SlideDeckMode; label: string; rules: string } {
  const mode = resolveSlideDeckMode(value);
  if (mode === "detailed") {
    return {
      mode,
      label: "상세형 — 발표 없이 읽어도 이해되는 교육자료",
      rules:
        "화면 문장은 3~4개로 구성하고, 각 문장이 이유·판단 조건·행동을 독립적으로 이해할 수 있게 쓰세요. 발표자 노트는 화면을 반복하지 말고 시범과 보충 설명을 담으세요.",
    };
  }
  return {
    mode,
    label: "발표형 — 핵심 메시지와 시각 구도 중심",
    rules:
      "화면 문장은 2~3개만 남겨 여백과 시각 구도를 확보하고, 상세 근거·교관 설명·질문은 발표자 노트에 담으세요.",
  };
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

export function buildGeneratePrompt(req: GenerateRequest, sopEvidence?: SopEvidence): string {
  if (req.type === "notebooklm") {
    throw new Error("notebooklm 유형은 buildNotebookLmPrompt 를 사용하세요.");
  }
  const topicLine = req.topic?.trim()
    ? `상위 훈련 주제: ${req.topic.trim()}`
    : "훈련 내용(주제): 분야 전반에서 가장 중요한 주제를 선정";
  const focus = req.focus?.replace(/\s+/g, " ").trim().slice(0, 100);
  const focusLine = focus
    ? `\n- 이번 세부 훈련 방향: ${focus}\n- 위 세부 방향에 집중하고, 상위 주제의 다른 방향은 선수지식이나 안전상 꼭 필요한 경우 외에는 섞지 마세요.`
    : "";
  const dateLine = req.date ? `\n- 훈련 일자: ${req.date} (문서 개요에 명시)` : "";
  const condition = conditionPromptParts(req.conditions);

  if (req.type === "slides") {
    const slideMode = slideModePromptParts(req.slideMode);
    return `전북소방본부 ${req.category} 분야 교육용 슬라이드를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration} (슬라이드 ${slideCountFor(req.duration)}장)
- 제작 모드: ${slideMode.label} (mode=${slideMode.mode})
- ${topicLine}${focusLine}${condition.line}

[구성]
① 측정 가능한 학습 목표 1장 ② 핵심 개념·절차(단계별로 1장씩) ③ 장비·사전점검
④ 현장 판단 사례 ⑤ 위험요소·중단 기준 ⑥ 핵심 요약과 확인 질문 1장

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- SOP 근거 상태는 시스템의 적용 계약을 따르세요. 기존 절차 또는 안전 장 중 최소 1장을 SOP 적용 근거 장으로 구성하고, 같은 장의 화면·노트에 ${SOP_APPLICATION_MARKER} 또는 상태별 고정 안내문을 넣으세요.
- SOP 근거가 확인된 경우 그 장의 sourceRefs에 허용 SOP 출처 라벨을 반드시 포함하세요.
- ${condition.rule}
- 결과 최상위 mode는 반드시 "${slideMode.mode}"로 지정하세요. ${slideMode.rules}
- 각 슬라이드 제목은 "안전 유의사항" 같은 분류명이 아니라, "압력이 부족하면 진입하지 않습니다"처럼
  그 장에서 기억할 결론이 드러나는 서술형 문장으로 쓰고 ${MAX_SLIDE_TITLE_CHARS}자 이내로 제한하세요.
- 화면에는 구체적인 핵심 문장 2~4개만 두고, 각 문장은 ${MAX_SLIDE_BULLET_CHARS}자 이내로 제한하며 한 장에는 하나의 메시지만 담으세요.
- 발표자 노트는 4~7문장으로 충분히 작성하세요. 근거가 되는 이유·교관이 보여줄 시범·대원에게 던질 질문·
  실수하기 쉬운 지점·잘못했을 때의 교정 방법 중 해당되는 내용을 포함하여 교관이 그대로 설명할 수 있게 하세요.
- **비교 장**은 steps에 양쪽 기준명 2개를, **절차·시간흐름·판단흐름 장**은 steps에 3~5개 단계 핵심어를
  순서대로 넣고 각 단계어는 ${MAX_SLIDE_STEP_CHARS}자 이내로 제한하세요. 나머지 장은 steps를 생략하세요.
- 각 장에 교육 역할 role과 화면 구도 composition을 서로 구분하여 지정하세요.
  · role: objectives, concept, procedure, equipment, comparison, timeline, decision, case, safety, evidence, summary
  · composition: statement, list, process, comparison, timeline, decision-flow, checklist, scenario, visual-explanation, summary
  같은 role을 여러 장에서 써도 화면 목적이 다르면 composition을 달리하고, 전체 덱에 최소 4종류의 composition을 사용하세요.
- 구체적인 현장 상황에서 대원이 우선 조치를 판단하는 장 → 대원이 직접 수행하고 피드백받는 실습 장 → 관찰 가능한 기준으로 평가하는 장의 순서를 포함하세요.
- 현장 판단 장에는 상황, 판단 조건, 우선 행동, 그 행동을 선택한 근거를 함께 적으세요. 참고 자료에 없는 상황 설정은 "훈련 가정:"으로 구분하세요.
- 참여 실습 장은 composition=process로 구성하고 steps에 3~5개의 실제 대원 행동 핵심어를 순서대로 넣으세요. 화면 또는 발표자 노트에는 시작 조건, 교관 시범, 대원 동작, 동작 후 확인, 이상 시 중단·보고, 자주 생기는 실수와 즉시 교정·재수행 방법을 포함하세요.
- 평가 장에는 참여 실습 장의 각 대원 행동과 직접 연결되는 관찰 항목, 통과 판단, 미달 항목의 피드백과 재수행 방법을 포함하세요. 자료에 없는 수치형 합격선을 만들지 마세요.
- 화학보호복 보호등급이나 장비 압력 수치가 둘 이상 나오면 한 절차로 섞거나 임의로 통일하지 말고, 등급·장비 모델·측정 조건과 해당 출처를 같은 장에서 명확히 구분하세요.
- '물 → 제독제 → 물'을 보편 절차로 단정하지 마세요. 해당 순서를 쓸 때는 물질 식별, SDS·제조사·SOP, 수반응성 및 제독제 적합 조건을 같은 장에 함께 밝히세요.
- 과거 저장본 호환 필드 layout도 함께 지정하세요: objectives, concept, process, equipment, case, safety, summary.
- visual은 모든 장에 지정하되, 원문 사진·표·도해가 교육에 직접 필요한 visual-explanation 장만 source-page를 사용하세요.
  참고 자료 본문에 사진·그림·표·도해·장비 구성처럼 실제 시각 단서가 확인되는 페이지를 우선하고, 텍스트 설명뿐인 페이지는 고르지 마세요.
  이때 sourceRef와 altText를 함께 적고 fit은 contain을 사용합니다. 절차·시간흐름·판단흐름은 native-diagram,
  시각자료가 필요 없는 장은 none을 사용하세요. assetId·documentId·imageData는 서버가 검증하여 연결하므로 만들지 마세요.
- 원문에 확인되지 않은 화학보호복·장비 외형이나 착용 절차를 그림으로 상상하지 마세요. 원문 시각자료를 연결할 수 없으면
  visual 메타데이터만 남겨 텍스트 대체 설명이 표시되게 하세요.
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
- ${topicLine}${focusLine}${dateLine}${placeLine}${condition.line}

아래 5개 항목을 **정확히 이 제목으로, 이 순서대로** 각각 하나의 섹션(heading=제목, content=내용)으로만 작성하세요. 다른 섹션을 추가하지 마세요.
1. 훈련목표 — 교육 후 대원이 실제로 수행하거나 설명할 수 있는 측정 가능한 목표 2~4개.
2. 훈련내용 — 이론교육·교관시범·반복실습·종합수행의 순서, 교관 행동, 대원 행동, 피드백 방법을 구체적으로 작성.
   각 단계 소제목에 [이론교육 · 20분]처럼 대괄호 안에 시간을 넣고, 표시한 시간 합계를 정확히 ${req.duration}으로 맞추세요.
   각 단계에는 '교관 행동:', '대원 행동:', '확인·피드백:'을 줄을 나눠 적고, 시범·실습 단계에는 '흔한 실수·교정:'도 적으세요.
   교관시범·반복실습·종합수행의 '대원 행동:' 아래에는 최소 3개의 관찰 가능한 행동을 '1) 동작 → 확인 지점' 형식으로 한 줄씩 작성하세요. 마지막에는 '이상 시:'로 중단·보고·교정 또는 재수행 방법을 적으세요.
   "숙지한다", "철저히 한다", "적절히 대응한다", "절차에 따라 수행한다"만으로는 행동절차로 인정하지 말고, 대원이 실제로 확인·조작·이동·선정·보고하는 동작을 쓰세요.
   첫 부분에 ${SOP_APPLICATION_MARKER} 소단락 또는 상태별 고정 안내문을 넣고, 적용 단계·역할 분담·중단·보고 기준을 근거 범위에서 연결하세요.
3. 필요장비 — 각 항목을 '장비 — 용도 / 사용 전 확인 / 이상 시 조치' 구조로 작성. 수량은 현장 조건이나 참고 자료에서 확인되는 경우에만 명시.
4. 안전관리 — 각 항목을 '위험요소 — 예방조치 / 중단 조건 / 보고·재개' 구조로 작성.
5. 훈련평가 — 훈련내용의 핵심 대원 행동 단계와 같은 순서로 연결하고, 각 항목을 '평가항목 — 관찰 가능한 수행 기준 / 통과 판단 / 미달 시 피드백·재수행' 구조로 작성. "이해했다" 같은 주관적 기준은 사용하지 마세요.

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치·장비명을 지어내지 마세요.
- ${buildSopPromptContract(sopEvidence).replace(/\n/g, "\n  ")}
- ${condition.rule}
- 대상 수준(${req.audience})에 맞는 난이도로, 현장에서 바로 쓸 수 있게 구체적으로 작성하세요.
- 목표·장비·안전·평가의 세부 항목은 한 문단에 이어 쓰지 말고 각 항목을 "- "로 시작해 줄바꿈하세요. 훈련내용의 [단계명 · 00분] 소제목도 각각 새 줄에서 시작하세요.
- 본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 붙이지 마세요. 검증된 출처는 완성 문서 맨 뒤의 '근거 자료 및 출처' 목록에 서버가 자동으로 모읍니다.
- 자료에 없는 수량·중단 기준·평가기준은 임의로 만들지 말고 "참고 자료에서 확인되지 않습니다"라고 밝히세요.
- 한국어로 작성하세요.`;
  }

  return `전북소방본부 ${req.category} 분야 교육자료(교안)를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration}
- ${topicLine}${focusLine}${dateLine}${condition.line}

[고정 구성 — 정확히 이 제목과 순서로 7개 섹션]
1. 학습목표 — 교육 종료 후 대원이 설명하거나 수행할 수 있는 측정 가능한 목표 2~4개.
2. 도입 — [시간: 00분]으로 시작. 실제 현장 상황 또는 확인 질문으로 필요성을 느끼게 하고 오늘 배울 내용을 연결.
3. 핵심이론 — [시간: 00분]으로 시작. 단순 정의가 아니라 이유·적용 조건·절차·주의점을 소단원으로 풀어 설명.
   시간 표기 다음에 ${SOP_APPLICATION_MARKER} 소단락 또는 상태별 고정 안내문을 넣고, 시범·실습에서 지킬 행동으로 연결.
4. 교관시범 — [시간: 00분]으로 시작. 교관의 동작·말할 내용·대원이 관찰할 지점을 순서대로 작성.
   각 시범 단계에 동작, 확인 지점, 동작 이유, 흔한 실수와 교정 설명을 연결.
5. 대원실습 — [시간: 00분]으로 시작. 조 편성·역할·반복 방법·교관 피드백·실수 교정·재수행 방법을 작성.
   '대원 행동절차:' 아래에 최소 3개의 관찰 가능한 행동을 '1) 동작 → 확인 지점' 형식으로 한 줄씩 적고, 마지막에는 '이상 시:' 중단·보고·교정 또는 재수행 방법을 작성.
6. 안전유의사항 — [시간: 00분]으로 시작. 위험요소·예방조치·즉시 중단 및 보고 기준을 작성.
7. 정리·평가 — [시간: 00분]으로 시작. 핵심 요약, 확인 질문과 모범답안, 대원실습의 행동 단계와 같은 순서로 연결한 관찰 가능한 수행평가 기준을 작성.

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${buildSopPromptContract(sopEvidence).replace(/\n/g, "\n  ")}
- ${condition.rule}
- 각 섹션을 교관이 별도 내용을 보충하지 않아도 진행할 수 있을 만큼 구체적으로 작성하세요.
- 대상 수준(${req.audience})에 맞춰 용어 설명·현장 적용·판단 조건의 깊이를 조절하세요.
- 대괄호로 표시한 여섯 단계의 시간 배분 합이 교육 시간(${req.duration})과 정확히 일치해야 합니다.
- 본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 붙이지 마세요. 검증된 출처는 완성 문서 맨 뒤의 '근거 자료 및 출처' 목록에 서버가 자동으로 모읍니다.
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
  | "missing_slide_role"
  | "missing_slide_composition"
  | "invalid_slide_composition"
  | "missing_slide_visual"
  | "invalid_slide_visual"
  | "generic_slide_title"
  | "mixed_chemical_protection_levels"
  | "conflicting_pressure_values"
  | "unqualified_decontamination_sequence"
  | "repetitive_slide_role"
  | "repetitive_slide_composition"
  | "missing_slide_scenario"
  | "missing_slide_practice"
  | "invalid_slide_learning_flow"
  | "missing_instructional_detail"
  | "missing_error_correction"
  | "missing_decision_rationale"
  | "missing_trainee_action_steps"
  | "missing_action_verification"
  | "missing_exception_response"
  | "missing_source_citation"
  | "missing_source_refs"
  | "invalid_source_ref"
  | "source_validation_unavailable"
  | SopQualityIssueCode;

export type GenerationQualityIssue = {
  code: GenerationQualityIssueCode;
  path: string;
  message: string;
  excerpt?: string;
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
  missing_slide_role: "슬라이드 교육 역할",
  missing_slide_composition: "슬라이드 화면 구성",
  invalid_slide_composition: "슬라이드 화면 구성과 내용",
  missing_slide_visual: "슬라이드 시각자료 계획",
  invalid_slide_visual: "슬라이드 시각자료 근거",
  generic_slide_title: "슬라이드 결론형 제목",
  mixed_chemical_protection_levels: "화학보호복 보호등급 정합성",
  conflicting_pressure_values: "장비 압력 수치 정합성",
  unqualified_decontamination_sequence: "제독 절차 적용 조건",
  repetitive_slide_role: "슬라이드 교육 역할 다양성",
  repetitive_slide_composition: "슬라이드 화면 구성 다양성",
  missing_slide_scenario: "현장 판단 시나리오",
  missing_slide_practice: "대원 참여 실습",
  invalid_slide_learning_flow: "시나리오·실습·평가 흐름",
  missing_instructional_detail: "교관·대원 수행과 피드백",
  missing_error_correction: "실수·오류 교정과 재수행",
  missing_decision_rationale: "현장 판단 조건과 근거",
  missing_trainee_action_steps: "대원 행동절차의 단계와 구체성",
  missing_action_verification: "행동 후 확인 지점",
  missing_exception_response: "이상 시 중단·보고·재수행",
  missing_source_citation: "핵심 내용의 근거 출처",
  missing_source_refs: "슬라이드별 근거 출처",
  invalid_source_ref: "근거 출처 표기",
  source_validation_unavailable: "근거 출처 재검증 정보",
  missing_sop_application: "SOP·표준절차 적용 내용",
  missing_sop_reference: "SOP·표준절차 근거 출처",
  missing_sop_disclosure: "SOP 근거 상태 안내",
  invalid_sop_reference: "SOP 출처 표기",
  unverified_sop_claim: "확인되지 않은 SOP 단정",
} as const satisfies Record<GenerationQualityIssueCode, string>;

/**
 * 저장·공식 파일 내보내기를 막아야 하는 핵심 품질 오류.
 * 화면 밀도나 문장 길이처럼 교관 판단으로 수용 가능한 항목은 경고로 남기고,
 * 교육 시간·안전·평가·필수 구성·근거 계약처럼 초안의 사용 가능성을 깨는 항목만 차단한다.
 */
export const BLOCKING_GENERATION_QUALITY_CODES: ReadonlySet<GenerationQualityIssueCode> =
  new Set<GenerationQualityIssueCode>([
    "missing_section",
    "missing_safety",
    "missing_evaluation",
    "missing_time_allocation",
    "time_total_mismatch",
    "thin_content",
    "slide_count",
    "missing_source_citation",
    "missing_source_refs",
    "invalid_source_ref",
    "source_validation_unavailable",
    "invalid_slide_visual",
    "mixed_chemical_protection_levels",
    "conflicting_pressure_values",
    "unqualified_decontamination_sequence",
    "missing_sop_application",
    "missing_sop_reference",
    "missing_sop_disclosure",
    "invalid_sop_reference",
    "unverified_sop_claim",
  ]);

export function blockingGenerationQualityIssues(
  quality: GenerationQualityReport
): GenerationQualityIssue[] {
  return quality.issues.filter((issue) =>
    BLOCKING_GENERATION_QUALITY_CODES.has(issue.code)
  );
}

export function warningGenerationQualityIssues(
  quality: GenerationQualityReport
): GenerationQualityIssue[] {
  return quality.issues.filter(
    (issue) => !BLOCKING_GENERATION_QUALITY_CODES.has(issue.code)
  );
}

function summarizedQualityLabels(labels: readonly string[], limit: number): string[] {
  const unique = Array.from(new Set(labels));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 4;
  const summary = unique.slice(0, safeLimit);
  if (unique.length > summary.length) {
    summary.push(`그 밖의 점검 항목 ${unique.length - summary.length}개`);
  }
  return summary;
}

/** 핵심 오류와 검토 권고를 분리해 화면·API가 같은 기준으로 표시한다. */
export function generationQualityMessages(
  quality: GenerationQualityReport,
  extraWarnings: readonly string[] = [],
  limit = 4
): { errors: string[]; warnings: string[] } {
  return {
    errors: summarizedQualityLabels(
      blockingGenerationQualityIssues(quality).map(
        (issue) => GENERATION_QUALITY_LABELS[issue.code]
      ),
      limit
    ),
    warnings: summarizedQualityLabels(
      [
        ...extraWarnings,
        ...warningGenerationQualityIssues(quality).map(
          (issue) => GENERATION_QUALITY_LABELS[issue.code]
        ),
      ],
      limit
    ),
  };
}

/** API와 클라이언트가 동일한 사용자용 품질 경고 문구를 사용하도록 변환한다. */
export function generationQualityWarnings(
  quality: GenerationQualityReport,
  extraLabels: readonly string[] = [],
  limit = 4
): string[] {
  return summarizedQualityLabels(
    [
      ...extraLabels,
      ...quality.issues.map((issue) => GENERATION_QUALITY_LABELS[issue.code]),
    ],
    limit
  );
}

export type GeneratedDocDraft = Pick<GeneratedDoc, "title" | "sections">;
export type GeneratedSlideDeckDraft = Pick<GeneratedSlideDeck, "title" | "slides" | "mode">;

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

const SAFETY_CUE = /안전|위험|보호|예방|통제|감시|대피/;
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
const CHEMICAL_PROTECTIVE_SUIT_CUE =
  /화학\s*(?:보호복|보호의)|화생방\s*(?:보호복|보호의)|내화학\s*(?:보호복|보호의)|유해화학(?:물질)?\s*(?:보호복|보호의)/i;
const PROTECTION_LEVEL_COMPARISON_CUE =
  /등급별|보호\s*등급|보호\s*수준|적용\s*조건|차이|구분|비교|선정\s*기준/;
const DECONTAMINATION_SEQUENCE_CUE =
  /물(?:\s*(?:세척|헹굼))?\s*(?:→|⇒|->|후|다음)\s*제독제(?:\s*(?:처리|도포|세척))?\s*(?:→|⇒|->|후|다음)\s*(?:다시\s*)?물/;
const DECONTAMINATION_CONDITION_CUE =
  /물질\s*(?:식별|확인|종류|특성)|오염물질\s*(?:식별|확인|종류|특성)|SDS|MSDS|제조사\s*(?:지침|기준)|SOP|수반응성|금수성|물과\s*반응|물\s*사용\s*(?:가능|금지|여부)|제독제\s*(?:적합|호환|선정)|전문가\s*(?:확인|자문)/i;
const SCENARIO_CONTEXT_CUE =
  /현장\s*상황|상황\s*(?:제시|가정|부여)|출동\s*(?:상황|현장)|사례|시나리오|요구조자|오염\s*구역/;
const SCENARIO_DECISION_CUE = /판단|결정|선택|조치|우선|무엇|어떻게|분기|대응/;
const PRACTICE_ACTION_CUE =
  /2인\s*1조|역할\s*(?:교대|분담|을\s*바꾸)|반복\s*(?:수행|훈련|연습)|직접\s*(?:수행|시연|착용|탈의|조작|점검)|대원\s*실습/;
const PERFORMANCE_EVALUATION_CUE =
  /평가|통과|수행\s*기준|판단\s*기준|모범답안|체크리스트.{0,30}(?:기준|충족)/;
const INSTRUCTOR_ACTION_CUE = /교관/;
const TRAINEE_ACTION_CUE = /대원/;
const DEMONSTRATION_CUE = /시범|보여\s*주|보여\s*줍|가리키|동작/;
const FEEDBACK_CUE = /피드백|강평|교정|보완|알려\s*주|기록/;
const COMMON_ERROR_CUE = /실수|오류|누락|놓치|잘못|오조작|이상\s*상태/;
const CORRECTION_CUE = /교정|피드백|재수행|다시\s*(?:수행|시범|평가)|보완\s*후/;
const DECISION_RATIONALE_CUE = /판단\s*근거|선택\s*근거|이유|때문|조건|따라/;
const OBSERVABLE_TRAINEE_ACTION_CUE =
  /확인|점검|결합|착용|탈의|연결|분리|조작|개방|폐쇄|이동|배치|설치|고정|인양|하강|수색|구조|선정|설정|측정|관찰|기록|호명|복창|통제|차단|대피|철수|운반|지지|확보|검지|식별|표시|보고|전파|교대/;
const ACTION_VERIFICATION_CUE =
  /확인\s*(?:지점|결과|사항|여부)?|점검|관찰|검증|대조|복창|시험|측정|정상\s*(?:상태|작동|여부)|표시(?:창|값|등)?/;
const ACTION_EXCEPTION_CUE = /이상|오류|누락|불량|위험|기준\s*미달|작동하지/;
const ACTION_EXCEPTION_RESPONSE_CUE =
  /중단|철수|교정|재수행|재점검|교체|분리|대피|복구|보완|다시\s*(?:수행|확인|점검)/;
const ACTION_REPORT_CUE = /보고|전파|통보|알려\s*(?:주|줍|야)|복창/;

const PRESSURE_EQUIPMENT_FAMILIES = [
  {
    key: "breathing-air",
    cue: /공기\s*호흡기|SCBA|호흡용\s*공기|등지게|면체|공기\s*용기/i,
  },
  {
    key: "pump-water",
    cue: /소방\s*펌프|펌프차|방수압|토출압|송수압|방수포/i,
  },
  {
    key: "hydraulic-rescue",
    cue: /유압|스프레더|유압\s*커터/i,
  },
  {
    key: "gas-cylinder",
    cue: /가스\s*용기|산소\s*용기|압축\s*가스|실린더/i,
  },
] as const;
type PressureEquipmentFamily = (typeof PRESSURE_EQUIPMENT_FAMILIES)[number]["key"];
type PressureSemanticKind = "alarm" | "test" | "rated" | "entry" | "operating";

const PRESSURE_DISTINCTION_CUE =
  /비교|구분|기종|모델|장비별|용기별|정격별|범위|[~∼]|부터|까지|이상.{0,20}(?:이하|미만)/;

function slideNarrativeText(slide: GeneratedSlide): string {
  return compactText(
    [slide.title, ...slide.bullets, ...(slide.steps ?? []), slide.notes]
      .filter(Boolean)
      .join(" ")
  );
}

function slideEvidenceText(slide: GeneratedSlide): string {
  return compactText(
    [
      slideNarrativeText(slide),
      ...(slide.sourceRefs ?? []),
      slide.visual?.sourceRef,
      slide.visual?.altText,
      slide.visual?.caption,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function chemicalProtectionLevels(text: string): Set<string> {
  const levels = new Set<string>();
  const namedLevelPattern = /\b(?:level|레벨)\s*[-:：]?\s*([abc])\b/gi;
  let match: RegExpExecArray | null;
  while ((match = namedLevelPattern.exec(text)) !== null) {
    levels.add(match[1].toUpperCase());
  }
  const koreanGradePattern = /(?:^|[^A-Za-z0-9])([ABC])\s*(?:급|등급)/g;
  while ((match = koreanGradePattern.exec(text)) !== null) {
    levels.add(match[1]);
  }
  return levels;
}

function pressureEquipmentFamily(
  text: string,
  deckFamilies: ReadonlySet<PressureEquipmentFamily>
): PressureEquipmentFamily | null {
  const local = PRESSURE_EQUIPMENT_FAMILIES.find(({ cue }) => cue.test(text));
  if (local) return local.key;
  return deckFamilies.size === 1 ? Array.from(deckFamilies)[0] : null;
}

function pressureSemanticKind(text: string, pressureIndex: number): PressureSemanticKind {
  const cues: Array<{ kind: PressureSemanticKind; pattern: RegExp }> = [
    { kind: "alarm", pattern: /경보|잔압|퇴각|철수|비상/g },
    { kind: "test", pattern: /시험|검사|기밀|누설/g },
    { kind: "rated", pattern: /정격|최대|완충|충전\s*(?:기준|압력)/g },
    {
      kind: "entry",
      pattern: /최소|이상|미만|진입|착용\s*전|사용\s*전|출동\s*전|시작|초기|준비/g,
    },
  ];
  let closestKind: PressureSemanticKind = "operating";
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const { kind, pattern } of cues) {
    let cue: RegExpExecArray | null;
    while ((cue = pattern.exec(text)) !== null) {
      const cueCenter = cue.index + cue[0].length / 2;
      const distance = Math.abs(cueCenter - pressureIndex);
      if (distance < closestDistance) {
        closestKind = kind;
        closestDistance = distance;
      }
    }
  }
  return closestKind;
}

function inspectSlideSafetyConsistency(
  draft: GeneratedSlideDeckDraft
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  const evidenceTexts = draft.slides.map(slideEvidenceText);
  const deckEvidence = compactText([draft.title, ...evidenceTexts].join(" "));

  if (CHEMICAL_PROTECTIVE_SUIT_CUE.test(deckEvidence)) {
    const levelOccurrences: Array<{
      levels: Set<string>;
      comparison: boolean;
      slideIndex: number | null;
    }> = [];
    const titleLevels = chemicalProtectionLevels(draft.title);
    if (titleLevels.size > 0) {
      levelOccurrences.push({
        levels: titleLevels,
        comparison:
          titleLevels.size >= 2 && PROTECTION_LEVEL_COMPARISON_CUE.test(draft.title),
        slideIndex: null,
      });
    }
    draft.slides.forEach((slide, index) => {
      const levels = chemicalProtectionLevels(evidenceTexts[index]);
      if (levels.size === 0) return;
      levelOccurrences.push({
        levels,
        comparison:
          levels.size >= 2 &&
          (slide.composition === "comparison" ||
            PROTECTION_LEVEL_COMPARISON_CUE.test(slideNarrativeText(slide))),
        slideIndex: index,
      });
    });
    const distinctLevels = new Set(
      levelOccurrences.flatMap(({ levels }) => Array.from(levels))
    );
    const deliberateComparison =
      levelOccurrences.length > 0 &&
      levelOccurrences.every(({ comparison }) => comparison);
    if (distinctLevels.size > 1 && !deliberateComparison) {
      const affectedIndices = Array.from(
        new Set(
          levelOccurrences.flatMap(({ slideIndex }) =>
            slideIndex === null ? [] : [slideIndex]
          )
        )
      ).sort((a, b) => a - b);
      const message = `화학보호복 보호등급 ${Array.from(distinctLevels).sort().join("/")}가 비교 장 밖에서 함께 사용되었습니다. 같은 등급으로 임의 통일하지 말고 각 절차의 적용 등급과 근거 출처를 분리해 확인하세요.`;
      if (affectedIndices.length === 0) {
        issues.push({ code: "mixed_chemical_protection_levels", path: "slides", message });
      } else {
        affectedIndices.forEach((index) => {
          issues.push({
            code: "mixed_chemical_protection_levels",
            path: `slides.${index}`,
            message,
            excerpt: compactText(evidenceTexts[index]).slice(0, 240),
          });
        });
      }
    }
  }

  const deckFamilies = new Set<PressureEquipmentFamily>();
  PRESSURE_EQUIPMENT_FAMILIES.forEach(({ key, cue }) => {
    if (cue.test(deckEvidence)) deckFamilies.add(key);
  });
  const pressureGroups = new Map<
    string,
    Array<{ valueBar: number; raw: string; slideIndex: number; comparison: boolean }>
  >();
  evidenceTexts.forEach((text, slideIndex) => {
    const pattern = /(\d{1,4}(?:\.\d+)?)\s*(bar|바|mpa)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = Math.max(0, match.index - 55);
      const end = Math.min(text.length, match.index + match[0].length + 55);
      const context = text.slice(start, end);
      const equipment = pressureEquipmentFamily(context, deckFamilies);
      if (!equipment) continue;
      const kind = pressureSemanticKind(context, match.index - start);
      const numericValue = Number(match[1]);
      if (!Number.isFinite(numericValue)) continue;
      const valueBar = match[2].toLocaleLowerCase() === "mpa" ? numericValue * 10 : numericValue;
      const key = `${equipment}:${kind}`;
      const mentions = pressureGroups.get(key) ?? [];
      mentions.push({
        valueBar,
        raw: match[0],
        slideIndex,
        comparison:
          draft.slides[slideIndex].composition === "comparison" ||
          PRESSURE_DISTINCTION_CUE.test(text),
      });
      pressureGroups.set(key, mentions);
    }
  });
  pressureGroups.forEach((mentions) => {
    const values = new Set(mentions.map(({ valueBar }) => valueBar));
    if (values.size <= 1) return;
    const slideIndices = new Set(mentions.map(({ slideIndex }) => slideIndex));
    const deliberateComparison =
      slideIndices.size === 1 && mentions.every(({ comparison }) => comparison);
    if (deliberateComparison) return;
    const message = `같은 장비·압력 기준에 ${Array.from(new Set(mentions.map(({ raw }) => raw))).join(" / ")}가 함께 사용되었습니다. 수치를 임의로 선택하지 말고 장비 모델·측정 조건·근거 출처를 구분해 확인하세요.`;
    Array.from(slideIndices)
      .sort((a, b) => a - b)
      .forEach((slideIndex) => {
        issues.push({
          code: "conflicting_pressure_values",
          path: `slides.${slideIndex}`,
          message,
          excerpt: compactText(evidenceTexts[slideIndex]).slice(0, 240),
        });
      });
  });

  draft.slides.forEach((slide, index) => {
    const text = slideNarrativeText(slide);
    if (
      DECONTAMINATION_SEQUENCE_CUE.test(text) &&
      !DECONTAMINATION_CONDITION_CUE.test(text)
    ) {
      issues.push({
        code: "unqualified_decontamination_sequence",
        path: `slides.${index}`,
        message:
          "'물 → 제독제 → 물' 순서를 공통 절차로 단정하기 전에 물질 식별, SDS·제조사·SOP, 수반응성 및 제독제 적합 조건을 같은 장에서 밝혀야 합니다.",
      });
    }
  });

  return issues;
}

function repeatedSlideDimension<T extends string>(
  values: readonly (T | undefined)[]
): { dominant: T; count: number; unique: number } | null {
  if (values.length < 6 || values.some((value) => !value)) return null;
  const counts = new Map<T, number>();
  values.forEach((value) => counts.set(value as T, (counts.get(value as T) ?? 0) + 1));
  const [dominant, count] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  const minimumKinds = values.length >= 8 ? 4 : 3;
  if (counts.size >= minimumKinds && count / values.length <= 0.6) return null;
  return { dominant, count, unique: counts.size };
}

function inspectSlideLearningFlow(
  draft: GeneratedSlideDeckDraft
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  const texts = draft.slides.map(slideNarrativeText);
  const scenarioIndex = texts.findIndex(
    (text) => SCENARIO_CONTEXT_CUE.test(text) && SCENARIO_DECISION_CUE.test(text)
  );
  const practiceIndex = texts.findIndex((text) => PRACTICE_ACTION_CUE.test(text));
  const evaluationIndex = texts.findIndex((text) => PERFORMANCE_EVALUATION_CUE.test(text));

  if (scenarioIndex < 0) {
    issues.push({
      code: "missing_slide_scenario",
      path: "slides",
      message: "대원이 조건을 읽고 우선 조치를 판단하는 구체적인 현장 상황 장이 필요합니다.",
    });
  }
  if (practiceIndex < 0) {
    issues.push({
      code: "missing_slide_practice",
      path: "slides",
      message: "대원이 직접 수행하고 동료·교관의 피드백을 받는 참여형 실습 장이 필요합니다.",
    });
  }
  if (scenarioIndex >= 0 && !DECISION_RATIONALE_CUE.test(texts[scenarioIndex])) {
    issues.push({
      code: "missing_decision_rationale",
      path: `slides.${scenarioIndex}`,
      message:
        "현장 판단 장에는 상황만 제시하지 말고 판단 조건·우선 행동·그 행동을 선택한 근거를 함께 설명해야 합니다.",
    });
  }
  if (
    practiceIndex >= 0 &&
    (!COMMON_ERROR_CUE.test(texts[practiceIndex]) ||
      !CORRECTION_CUE.test(texts[practiceIndex]))
  ) {
    issues.push({
      code: "missing_error_correction",
      path: `slides.${practiceIndex}`,
      message:
        "참여 실습 장에는 자주 생기는 실수와 교관·동료의 교정 또는 재수행 방법을 함께 넣어야 합니다.",
    });
  }
  if (practiceIndex >= 0) {
    issues.push(
      ...inspectTraineeActionProcedure(
        texts[practiceIndex],
        `slides.${practiceIndex}`,
        draft.slides[practiceIndex].steps
      )
    );
  }
  if (
    scenarioIndex >= 0 &&
    practiceIndex >= 0 &&
    evaluationIndex >= 0 &&
    !(scenarioIndex < practiceIndex && practiceIndex < evaluationIndex)
  ) {
    issues.push({
      code: "invalid_slide_learning_flow",
      path: "slides",
      message: "현장 상황에서 판단한 뒤 직접 실습하고 마지막에 수행 기준으로 평가하는 순서로 구성하세요.",
    });
  }

  const repeatedRole = repeatedSlideDimension(draft.slides.map(({ role }) => role));
  if (repeatedRole) {
    issues.push({
      code: "repetitive_slide_role",
      path: "slides",
      message: `role '${repeatedRole.dominant}'이 ${draft.slides.length}장 중 ${repeatedRole.count}장에 반복되고 전체 role이 ${repeatedRole.unique}종뿐입니다. 학습 흐름에 맞게 역할을 나누세요.`,
    });
  }
  const repeatedComposition = repeatedSlideDimension(
    draft.slides.map(({ composition }) => composition)
  );
  if (repeatedComposition) {
    issues.push({
      code: "repetitive_slide_composition",
      path: "slides",
      message: `composition '${repeatedComposition.dominant}'이 ${draft.slides.length}장 중 ${repeatedComposition.count}장에 반복되고 전체 구도가 ${repeatedComposition.unique}종뿐입니다. 메시지에 맞는 화면 구도를 분산하세요.`,
    });
  }
  return issues;
}

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

/**
 * 구성안이 선택한 정확한 출처 라벨의 청크만 다음 작성 단계에 전달한다.
 * 라벨이 없는 과거 체크포인트나 검색 형식 불일치 시에는 근거 손실을 막기 위해 전체 문맥을 유지한다.
 */
export function selectGenerationContextBySourceRefs(
  contextText: string,
  sourceRefs: readonly string[]
): string {
  const selected = new Set(
    sourceRefs
      .map((sourceRef) => normalizedSourceLabelKey(sourceRef))
      .filter(Boolean)
  );
  if (selected.size === 0) return contextText;

  const matched = contextText
    .split("\n\n---\n\n")
    .filter((segment) =>
      extractSourceLabels(segment).some((label) =>
        selected.has(normalizedSourceLabelKey(label))
      )
    );
  return matched.length > 0 ? matched.join("\n\n---\n\n") : contextText;
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

function inspectInstructionalDetail(
  content: string,
  path: string
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  if (
    !INSTRUCTOR_ACTION_CUE.test(content) ||
    !TRAINEE_ACTION_CUE.test(content) ||
    !FEEDBACK_CUE.test(content)
  ) {
    issues.push({
      code: "missing_instructional_detail",
      path,
      message:
        "교관 행동·대원 행동·확인 또는 피드백이 실제 진행 순서 안에서 함께 드러나야 합니다.",
    });
  }
  if (!COMMON_ERROR_CUE.test(content) || !CORRECTION_CUE.test(content)) {
    issues.push({
      code: "missing_error_correction",
      path,
      message:
        "실습에서 자주 생기는 실수·누락과 이를 교정하거나 재수행하는 방법을 함께 작성해야 합니다.",
    });
  }
  issues.push(...inspectTraineeActionProcedure(content, path));
  return issues;
}

function numberedActionSteps(content: string): string[] {
  const steps: string[] = [];
  const pattern = /(?:^|\n)\s*(?:\d{1,2}[.)]|[\u2460-\u2473])\s*([^\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) steps.push(match[1].trim());
  return steps;
}

function inspectTraineeActionProcedure(
  content: string,
  path: string,
  structuredSteps?: readonly string[]
): GenerationQualityIssue[] {
  const issues: GenerationQualityIssue[] = [];
  const steps = (structuredSteps?.length ? structuredSteps : numberedActionSteps(content)).map(
    (step) => step.trim()
  );
  const concreteSteps = steps.filter((step) => OBSERVABLE_TRAINEE_ACTION_CUE.test(step));
  const distinctSteps = new Set(steps.map((step) => normalizedKey(step))).size;
  if (
    steps.length < 3 ||
    concreteSteps.length < Math.min(3, steps.length) ||
    distinctSteps < 3
  ) {
    issues.push({
      code: "missing_trainee_action_steps",
      path,
      message:
        "대원 행동절차를 최소 3개의 관찰 가능한 동작으로 순서화하고, 추상적인 '숙지·철저·적절히 수행' 표현을 실제 확인·조작·이동·보고 행동으로 바꾸세요.",
    });
  }
  const verifiedSteps = steps.filter((step) => ACTION_VERIFICATION_CUE.test(step));
  if (verifiedSteps.length < Math.min(2, steps.length)) {
    issues.push({
      code: "missing_action_verification",
      path,
      message:
        "대원 행동 단계마다 정상 여부나 수행 결과를 확인할 지점을 연결하고, 최소 2개 단계에서 확인 방법이 명확히 드러나야 합니다.",
    });
  }
  if (
    !ACTION_EXCEPTION_CUE.test(content) ||
    !ACTION_EXCEPTION_RESPONSE_CUE.test(content) ||
    !ACTION_REPORT_CUE.test(content)
  ) {
    issues.push({
      code: "missing_exception_response",
      path,
      message:
        "이상·누락이 발견됐을 때의 중단 또는 교정, 보고, 재점검·재수행 흐름을 행동절차와 연결해야 합니다.",
    });
  }
  return issues;
}

function inspectInstructorDemonstration(
  content: string,
  path: string
): GenerationQualityIssue[] {
  if (
    INSTRUCTOR_ACTION_CUE.test(content) &&
    TRAINEE_ACTION_CUE.test(content) &&
    DEMONSTRATION_CUE.test(content)
  ) {
    return [];
  }
  return [
    {
      code: "missing_instructional_detail",
      path,
      message:
        "교관이 보여 줄 동작·확인 지점과 대원이 관찰하거나 답할 내용을 순서대로 작성해야 합니다.",
    },
  ];
}

function isDocumentControlMarker(reference: string): boolean {
  if (reference === SOP_APPLICATION_MARKER) return true;
  const body = reference.slice(1, -1).trim();
  if (/(?:p\.\s*\d+|출처|제한\s*시간)/i.test(body)) return false;
  return /^(?:시간\s*[:：]\s*|[^\[\]\n]{1,50}?\s*[·•∙]\s*)\d+\s*(?:분|시간)(?:\s*(?:[\/|,;·•∙-].*)?)?$/.test(
    body
  );
}

const DOCUMENT_SOURCE_LABEL_CUE =
  /(?:p\.\s*\d+|출처|교범|교재|지침|매뉴얼|참고\s*자료|근거\s*자료|표준\s*(?:작전)?\s*절차|\bSOP\b)/i;

function isDocumentSourceLabel(
  reference: string,
  allowedSourceRefs: ReadonlySet<string>
): boolean {
  const normalized = reference.trim();
  if (isDocumentControlMarker(normalized)) return false;
  return allowedSourceRefs.has(normalized) || DOCUMENT_SOURCE_LABEL_CUE.test(normalized);
}

/**
 * 훈련계획·교안 본문의 인라인 출처를 제거한다.
 *
 * LLM이 프롬프트를 따르지 않더라도 검증된 출처는 `GeneratedDoc.sources`로
 * 문서 맨 뒤에만 남긴다. 시간 배분과 `[관련 SOP 적용]` 같은 문서 제어 표식은
 * 출처가 아니므로 그대로 보존한다.
 */
export function stripDocumentInlineSourceRefsFromText(
  content: string,
  allowedSourceRefs: readonly string[] = []
): string {
  const allowed = new Set(allowedSourceRefs.map((reference) => reference.trim()).filter(Boolean));
  const stripped = content.replace(INLINE_SOURCE_REF, (reference) =>
    isDocumentSourceLabel(reference, allowed) ? "" : reference
  );

  return stripped
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+([,.;:!?])/g, "$1")
        .replace(/[,;]\s*([.!?])/g, "$1")
        .replace(/([.!?])\s*[.!?]+/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 전체 훈련계획·교안 초안을 표시용 본문과 맨 뒤 근거 목록으로 분리한다. */
export function stripDocumentInlineSourceRefs<T extends GeneratedDocDraft>(
  draft: T,
  allowedSourceRefs: readonly string[] = []
): T {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      content: stripDocumentInlineSourceRefsFromText(section.content, allowedSourceRefs),
    })),
  };
}

/** 섹션 하나만 재생성할 때도 전체 문서와 같은 출처 표시 규칙을 적용한다. */
export function stripSectionInlineSourceRefs<T extends GeneratedSection>(
  section: T,
  allowedSourceRefs: readonly string[] = []
): T {
  return {
    ...section,
    content: stripDocumentInlineSourceRefsFromText(section.content, allowedSourceRefs),
  };
}

function inspectDocumentSourceReferences(
  sections: readonly GeneratedSection[],
  documentHeadings: readonly string[],
  allowedSourceRefs?: readonly string[]
): GenerationQualityIssue[] {
  if (!allowedSourceRefs || allowedSourceRefs.length === 0) return [];

  const issues: GenerationQualityIssue[] = [];
  const allowed = new Set(allowedSourceRefs.map((sourceRef) => sourceRef.trim()));
  for (const heading of documentHeadings) {
    const found = findSection(sections, heading);
    if (!found) continue;
    const refs = Array.from(
      new Set(
        (found.section.content.match(INLINE_SOURCE_REF) ?? [])
          .map((ref) => ref.trim())
          .filter((ref) => !isDocumentControlMarker(ref))
      )
    );
    refs
      .filter((ref) => !allowed.has(ref))
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
  allowedSourceRefs?: readonly string[],
  sopEvidence?: SopEvidence
): GenerationQualityReport {
  const issues = inspectSectionContract(draft.sections, TRAINING_PLAN_SECTIONS, PLAN_MIN_CHARS);
  const training = findSection(draft.sections, "훈련내용");
  if (training) {
    issues.push(
      ...inspectTimeTotal(
        [{ content: training.section.content, path: `sections.${training.index}.content` }],
        duration
      ),
      ...inspectInstructionalDetail(
        training.section.content,
        `sections.${training.index}.content`
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
    ...inspectDocumentSourceReferences(
      draft.sections,
      TRAINING_PLAN_SECTIONS,
      allowedSourceRefs
    )
  );
  if (sopEvidence) {
    issues.push(...inspectSopContract("plan", draft, sopEvidence).issues);
  }
  return report(issues);
}

/** 교안의 실전 교육 흐름, 섹션별 분량, 단계별 시간, 안전·평가 기준을 검사한다. */
export function inspectGeneratedLesson(
  draft: GeneratedDocDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[],
  sopEvidence?: SopEvidence
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

  const demonstration = findSection(draft.sections, "교관시범");
  if (demonstration) {
    issues.push(
      ...inspectInstructorDemonstration(
        demonstration.section.content,
        `sections.${demonstration.index}.content`
      )
    );
  }
  const practice = findSection(draft.sections, "대원실습");
  if (practice) {
    issues.push(
      ...inspectInstructionalDetail(
        practice.section.content,
        `sections.${practice.index}.content`
      )
    );
  }

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
    ...inspectDocumentSourceReferences(
      draft.sections,
      LESSON_SECTIONS,
      allowedSourceRefs
    )
  );
  if (sopEvidence) {
    issues.push(...inspectSopContract("lesson", draft, sopEvidence).issues);
  }
  return report(issues);
}

/** 슬라이드 수, 화면 내용, 교관 노트, 출처, 의미 레이아웃, 안전·평가 장, 중복을 검사한다. */
export function inspectGeneratedSlides(
  draft: GeneratedSlideDeckDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[],
  sopEvidence?: SopEvidence
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
    if (!slide.layout && !slide.composition) {
      issues.push({
        code: "missing_slide_layout",
        path: `slides.${index}.layout`,
        message: "내용 의미에 맞는 화면 구도(composition 또는 legacy layout)를 지정해야 합니다.",
      });
    }
    if (!slide.role) {
      issues.push({
        code: "missing_slide_role",
        path: `slides.${index}.role`,
        message: "이 장이 교육 흐름에서 맡는 role을 지정해야 합니다.",
      });
    }
    if (!slide.composition) {
      issues.push({
        code: "missing_slide_composition",
        path: `slides.${index}.composition`,
        message: "교육 역할과 별도로 화면 composition을 지정해야 합니다.",
      });
    }
    const stepCount = slide.steps?.filter((step) => step.trim()).length ?? 0;
    if (slide.composition === "comparison" && stepCount !== 2) {
      issues.push({
        code: "invalid_slide_composition",
        path: `slides.${index}.steps`,
        message: "comparison 화면은 양쪽 기준명 2개를 steps에 넣어야 합니다.",
      });
    }
    if (
      (slide.composition === "process" ||
        slide.composition === "timeline" ||
        slide.composition === "decision-flow") &&
      (stepCount < 3 || stepCount > 5)
    ) {
      issues.push({
        code: "invalid_slide_composition",
        path: `slides.${index}.steps`,
        message: `${slide.composition} 화면은 순서대로 3~5개 단계어가 필요합니다.`,
      });
    }
    if (!slide.visual) {
      issues.push({
        code: "missing_slide_visual",
        path: `slides.${index}.visual`,
        message: "원문 시각자료·기본 도형·사용 안 함 중 시각자료 계획을 지정해야 합니다.",
      });
    } else {
      const visual = slide.visual;
      const isSourceVisual = visual.mode === "source-page" || visual.mode === "source-crop";
      const visualRef = visual.sourceRef?.trim();
      if (isSourceVisual && (!visualRef || !visual.altText?.trim())) {
        issues.push({
          code: "invalid_slide_visual",
          path: `slides.${index}.visual`,
          message: "원문 시각자료에는 정확한 sourceRef와 대체 텍스트가 필요합니다.",
        });
      }
      if (
        visualRef &&
        (!SOURCE_REF_FORMAT.test(visualRef) || (allowedSources && !allowedSources.has(visualRef)))
      ) {
        issues.push({
          code: "invalid_slide_visual",
          path: `slides.${index}.visual.sourceRef`,
          message: `시각자료 출처 '${visual.sourceRef}'는 현재 참고 자료 라벨과 정확히 일치해야 합니다.`,
        });
      }
      if (
        slide.composition === "visual-explanation" &&
        visual.mode !== "source-page" &&
        visual.mode !== "source-crop"
      ) {
        issues.push({
          code: "invalid_slide_visual",
          path: `slides.${index}.visual.mode`,
          message: "visual-explanation 화면은 검증된 원문 페이지를 연결해야 합니다.",
        });
      }
      if (isSourceVisual && slide.composition !== "visual-explanation") {
        issues.push({
          code: "invalid_slide_visual",
          path: `slides.${index}.composition`,
          message: "원문 페이지 시각자료는 visual-explanation 화면에서만 사용할 수 있습니다.",
        });
      }
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

    if (SAFETY_CUE.test(slideText) && STOP_OR_REPORT_CUE.test(slideText)) {
      hasSafety = true;
    }
    if (PERFORMANCE_EVALUATION_CUE.test(slideText)) {
      hasEvaluation = true;
    }
  });

  issues.push(...inspectSlideSafetyConsistency(draft));
  issues.push(...inspectSlideLearningFlow(draft));

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
  if (sopEvidence) {
    issues.push(...inspectSopContract("slides", draft, sopEvidence).issues);
  }
  return report(issues);
}

export function inspectGenerationQuality(
  type: "plan" | "lesson" | "slides",
  draft: GeneratedDocDraft | GeneratedSlideDeckDraft,
  duration: Duration,
  allowedSourceRefs?: readonly string[],
  sopEvidence?: SopEvidence
): GenerationQualityReport {
  if (type === "slides") {
    return inspectGeneratedSlides(
      draft as GeneratedSlideDeckDraft,
      duration,
      allowedSourceRefs,
      sopEvidence
    );
  }
  if (type === "plan") {
    return inspectGeneratedPlan(
      draft as GeneratedDocDraft,
      duration,
      allowedSourceRefs,
      sopEvidence
    );
  }
  return inspectGeneratedLesson(
    draft as GeneratedDocDraft,
    duration,
    allowedSourceRefs,
    sopEvidence
  );
}

/** API 응답·저장본이 보관한 실제 출처 라벨을 사용해 사용자 편집본을 다시 검사한다. */
export function inspectCurrentGenerationQuality(
  type: "plan" | "lesson" | "slides",
  draft: GeneratedDoc | GeneratedSlideDeck,
  duration: Duration
): GenerationQualityReport {
  const checked = inspectGenerationQuality(
    type,
    draft,
    duration,
    draft.sourceLabels,
    draft.sopEvidence
  );
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
    | "category"
    | "audience"
    | "duration"
    | "topic"
    | "focus"
    | "conditions"
    | "slideMode"
  >;
  draft: GeneratedDocDraft | GeneratedSlideDeckDraft;
  report: GenerationQualityReport;
  sopEvidence?: SopEvidence;
}): string {
  if (args.report.ok || args.report.issues.length === 0) {
    throw new Error("수정할 품질 문제가 없습니다.");
  }
  const issueLines = args.report.issues
    .map((issue, index) => `${index + 1}. [${issue.code}] ${issue.path}: ${issue.message}`)
    .join("\n");
  const repairSlideMode = resolveSlideDeckMode(
    args.request.slideMode ?? (args.draft as GeneratedSlideDeckDraft).mode
  );
  const structure =
    args.type === "plan"
      ? `sections는 ${TRAINING_PLAN_SECTIONS.join(" → ")}의 정확히 5개를 같은 순서로 유지하세요.`
      : args.type === "lesson"
        ? `sections는 ${LESSON_SECTIONS.join(" → ")}의 정확히 7개를 같은 순서로 유지하세요.`
        : `본문 슬라이드는 ${slideCountFor(args.request.duration)}장으로 맞추고, 최상위 mode는 ${repairSlideMode}로 유지하세요. 모든 장에 role·composition·legacy layout·visual·sourceRefs를 넣으세요. 제목은 ${MAX_SLIDE_TITLE_CHARS}자, 각 핵심 문장은 ${MAX_SLIDE_BULLET_CHARS}자, 각 단계어는 ${MAX_SLIDE_STEP_CHARS}자 이내로 다듬으세요.`;
  const condition = conditionPromptParts(args.request.conditions);
  const slideRepairRules =
    args.type === "slides"
      ? `
- 보호등급·압력 수치·제독 순서의 정합성 문제는 값을 임의로 하나로 통일하거나 새 절차를 만들지 마세요. 적용 조건과 근거 출처를 분리해 명시하고, 참고 자료로 구분할 수 없으면 "참고 자료에서 확인되지 않습니다"라고 밝히세요.
- 현장 상황 판단 → 대원 참여 실습 → 수행평가 순서를 만들고, 같은 role·composition의 과도한 반복은 각 장의 실제 교육 목적에 맞게 분산하세요.
- 참여 실습 장은 steps에 실제 대원 행동 3~5개를 순서대로 넣고, 노트에는 시작 조건·동작 후 확인·이상 시 중단과 보고·교정 및 재수행을 연결하세요. 평가 장은 이 행동들을 같은 순서로 관찰하게 하세요.`
      : `
- 훈련내용 또는 대원실습에는 '대원 행동절차:'와 최소 3개의 번호 행동을 줄마다 작성하세요. 각 행동은 실제 동작과 확인 지점을 연결하고, 마지막에 이상 시 중단·보고·교정 또는 재수행을 적으세요.
- 자료에 고정 순서가 없으면 기술 절차를 새로 만들지 말고 교육 진행 순서임을 밝힌 뒤 판단 조건 → 행동 → 확인 → 보고로 구성하세요.`;
  const citationRepairRule =
    args.type === "slides"
      ? "출처 라벨은 [참고 자료]에 표시된 문자열만 각 장의 sourceRefs에 그대로 적으세요."
      : "훈련계획·교안 본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 넣지 마세요. 검증된 출처는 서버가 문서 맨 뒤의 '근거 자료 및 출처' 목록으로 자동 구성합니다.";

  return `아래 ${args.type === "plan" ? "훈련계획" : args.type === "lesson" ? "교안" : "슬라이드"} 초안을 품질 검사 결과에 따라 전체 수정하세요.

[요청 조건]
- 분야: ${args.request.category}
- 대상: ${args.request.audience}
- 교육 시간: ${args.request.duration}
- 주제: ${args.request.topic?.trim() || "분야 핵심 주제"}
${args.request.focus?.trim() ? `- 세부 훈련 방향: ${args.request.focus.trim()} (다른 세부 방향을 섞지 않음)` : ""}
${condition.line.trimStart()}

[반드시 고칠 문제]
${issueLines}

[수정 원칙]
- ${structure}
- ${condition.rule}
- ${buildSopPromptContract(args.sopEvidence).replace(/\n/g, "\n  ")}
${slideRepairRules}
- 시스템 프롬프트의 [참고 자료]에 있는 내용만 사용하세요. 분량을 채우려고 일반 상식·수치·절차·사례를 만들지 마세요.
- 초안에 이미 있는 근거 있는 내용은 보존하되, 중복을 제거하고 교관·대원의 실제 행동과 평가 기준을 구체화하세요.
- ${citationRepairRule} 확인할 수 없는 내용은 "참고 자료에서 확인되지 않습니다"라고 쓰세요.
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
  /** 같은 저장본을 여러 화면에서 편집할 때 덮어쓰기를 막는 DB 개정 번호. */
  revision: number;
  shared?: boolean;
  author_name?: string | null;
  created_at: string;
};

// ── 부분 재생성 (섹션/슬라이드 1개) ──
export const regeneratedSectionSchema = z.object({
  heading: z.string().describe("섹션 제목 (번호 포함, 예: '3. 단계별 진행')"),
  content: z
    .string()
    .describe("섹션 본문. 줄바꿈(\\n)으로 항목을 구분하고 출처 라벨은 본문에 적지 않음"),
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
  topic?: string;
  focus?: string;
  sopEvidence?: SopEvidence;
  conditions?: string;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  const condition = conditionPromptParts(args.conditions);
  const focusLine = args.focus?.trim()
    ? `\n[세부 훈련 방향] ${args.focus.trim()} (상위 주제: ${args.topic?.trim() || args.category})`
    : args.topic?.trim()
      ? `\n[훈련 주제] ${args.topic.trim()}`
      : "";
  const isSopSection =
    args.currentHeading.trim() === "훈련내용" || args.currentHeading.trim() === "핵심이론";
  const isActionProcedureSection =
    args.currentHeading.trim() === "훈련내용" ||
    args.currentHeading.trim() === "교관시범" ||
    args.currentHeading.trim() === "대원실습" ||
    args.currentHeading.trim() === "정리·평가";
  const sopRule = isSopSection
    ? `\n- 이 섹션은 SOP 지정 위치입니다. ${buildSopPromptContract(args.sopEvidence).replace(/\n/g, "\n  ")}`
    : "";
  const actionProcedureRule = isActionProcedureSection
    ? `
- 대원 행동절차는 최소 3개의 번호 행동을 줄마다 적고, 각 행동의 실제 동작과 확인 지점을 연결하세요.
- 이상·누락 시 중단 또는 교정 → 보고 → 재점검·재수행을 작성하세요. 자료에 고정 순서가 없으면 기술 절차를 만들지 말고 교육 진행 순서임을 밝히세요.`
    : "";
  return `전북소방본부 ${args.category} 분야 교육 문서 "${args.docTitle}"의 한 섹션만 다시 작성합니다.

[문서 전체 구성]
${outlineText}

[다시 작성할 섹션] ${args.index + 1}번째 — "${args.currentHeading}"
[요청 조건]${focusLine}${condition.line}
[현재 내용]
${args.currentContent}${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 다른 섹션과 중복되지 않게, 이 섹션의 역할에 충실하게 작성하세요.
- 선택된 세부 훈련 방향이 있으면 그 범위에 집중하고 다른 방향을 새로 섞지 마세요.${sopRule}
${actionProcedureRule}
- 본문 문장 뒤에 [문서명 p.3]과 같은 출처 라벨을 붙이지 마세요. 출처는 서버가 전체 문서 맨 뒤의 '근거 자료 및 출처'에 자동으로 모읍니다.
- 대상 수준(${args.audience})·교육 시간(${args.duration})에 맞춰 한국어로 작성하세요.
- heading은 반드시 현재 제목 "${args.currentHeading}"을 글자 그대로 유지하세요.
- 이 섹션 하나만 JSON으로 반환하세요(heading, content).`;
}

// 슬라이드 1개 재생성 프롬프트 — 전체 슬라이드 구성 안에서 해당 1장만 다시 쓴다.
export function buildSlideRegenPrompt(args: {
  category: string;
  audience: Audience;
  duration: Duration;
  slideMode?: SlideDeckMode;
  deckTitle: string;
  outline: string[];
  index: number;
  current: GeneratedSlide;
  topic?: string;
  focus?: string;
  sopEvidence?: SopEvidence;
  conditions?: string;
  /** exact 표식이 없는 과거 저장본에서 사용자가 선택한 장을 SOP 복구 대상으로 강제한다. */
  sopTarget?: boolean;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  const condition = conditionPromptParts(args.conditions);
  const slideMode = slideModePromptParts(args.slideMode);
  const focusLine = args.focus?.trim()
    ? `\n[세부 훈련 방향] ${args.focus.trim()} (상위 주제: ${args.topic?.trim() || args.category})`
    : args.topic?.trim()
      ? `\n[훈련 주제] ${args.topic.trim()}`
      : "";
  const currentText = `${args.current.title}\n${args.current.bullets.join("\n")}\n${args.current.notes}`;
  const isSopSlide =
    args.sopTarget === true ||
    currentText.includes(SOP_APPLICATION_MARKER) ||
    currentText.includes(SOP_NOT_FOUND_DISCLOSURE) ||
    currentText.includes(SOP_DEGRADED_DISCLOSURE);
  const sopRule = isSopSlide
    ? `\n- 이 장은 SOP 적용 근거 장입니다. ${buildSopPromptContract(args.sopEvidence).replace(/\n/g, "\n  ")}`
    : "";
  return `전북소방본부 ${args.category} 분야 발표 "${args.deckTitle}"의 슬라이드 한 장만 다시 작성합니다.

[발표 전체 구성]
${outlineText}

[다시 작성할 슬라이드] ${args.index + 1}번째 — "${args.current.title}"
[제작 모드] ${slideMode.label}
[요청 조건]${focusLine}${condition.line}
[현재 내용]
${args.current.bullets.map((b) => `· ${b}`).join("\n")}
(노트: ${args.current.notes})${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- ${condition.rule}
- 다른 슬라이드와 중복되지 않게 작성하세요.
- 선택된 세부 훈련 방향이 있으면 그 범위에 집중하고 다른 방향을 새로 섞지 마세요.${sopRule}
- 제목은 분류명이 아니라 이 장의 결론이 드러나는 서술형으로 ${MAX_SLIDE_TITLE_CHARS}자 이내로 쓰고, 핵심 문장은 구체적으로 2~4개를 각각 ${MAX_SLIDE_BULLET_CHARS}자 이내로 작성하세요.
- 발표자 노트는 이유·시범 포인트·질문·흔한 실수·교정 방법 중 해당 내용을 포함해 4~7문장으로 작성하세요.
- ${slideMode.rules}
- 비교 장이면 steps에 기준명 2개를, 절차·시간흐름·판단흐름 장이면 ${MAX_SLIDE_STEP_CHARS}자 이내의 단계어 3~5개를 넣고, 아니면 steps를 생략하세요.
- 참여 실습 또는 절차 장이면 steps를 실제 대원 행동 3~5개로 구성하고, 화면·노트에 동작 후 확인과 이상 시 중단·보고·재수행을 연결하세요. 근거에 고정 순서가 없으면 기술 절차를 임의로 만들지 마세요.
- 내용 의미에 맞는 role과 composition을 서로 구분해 지정하고, 호환용 layout도 함께 지정하세요.
- visual은 source-page/native-diagram/none 중 하나로 지정하세요. 원문 시각자료는 참고 자료 본문에 사진·그림·표·도해 같은 시각 단서가 확인되는 경우에만 visual-explanation 화면에서 사용하고 정확한 sourceRef와 altText를 넣되 assetId·documentId·imageData는 만들지 마세요.
- sourceRefs에는 참고 자료의 출처 라벨을 글자 그대로 1~4개 넣으세요.
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
