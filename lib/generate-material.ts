// 생성물 ↔ 폼 상태 변환 (순수 함수, 클라이언트/서버 공용).
// UI(components/generate/*)에서 분리해 두면 저장본 복원 규칙을 테스트로 고정할 수 있다.
import {
  AUDIENCES,
  DURATIONS,
  MAX_GENERATION_CONDITIONS_CHARS,
  SLIDE_COMPOSITION_TYPES,
  SLIDE_LAYOUT_TYPES,
  SLIDE_ROLE_TYPES,
  SLIDE_VISUAL_FITS,
  SLIDE_VISUAL_MODES,
  type Audience,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedDocSource,
  type GeneratedSection,
  type GeneratedSlide,
  type GeneratedSlideDeck,
  type GeneratedSlideVisual,
  type SavedMaterial,
  resolveSlideDeckMode,
} from "@/lib/generate";

export const DEFAULT_AUDIENCE: Audience = "일반 대원";
export const DEFAULT_DURATION: Duration = "2시간";

export const asAudience = (v?: string | null): Audience =>
  AUDIENCES.includes(v as Audience) ? (v as Audience) : DEFAULT_AUDIENCE;

export const asDuration = (v?: string | null): Duration =>
  DURATIONS.includes(v as Duration) ? (v as Duration) : DEFAULT_DURATION;

/** 자료 제작은 정밀 모델을 우선하고, 없으면 서버가 제공한 첫 모델을 사용한다. */
export const preferredGenerationModel = (
  models: readonly { key: string }[]
): string => models.find((model) => model.key === "gemini-pro")?.key ?? models[0]?.key ?? "";

/** 과거 NotebookLM 결과는 열람만 유지하고 신규 작성 UI는 지원 유형으로 시작한다. */
export const initialGenerationType = (kind?: GenType | null): GenType =>
  kind === "notebooklm" ? "plan" : (kind ?? "plan");

export type HydratedMaterial = {
  doc: GeneratedDoc | null;
  deck: GeneratedSlideDeck | null;
  nlm: string | null;
  conditions: string;
  date: string;
  place: string;
  focus: string;
};

function storedSopEvidence(value: unknown): GeneratedDoc["sopEvidence"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Record<string, unknown>;
  if (
    evidence.status !== "found" &&
    evidence.status !== "not_found" &&
    evidence.status !== "degraded"
  ) {
    return undefined;
  }
  return {
    status: evidence.status,
    sourceLabels: storedSourceLabels(evidence.sourceLabels) ?? [],
  };
}

function storedSourceLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean)
    )
  ).slice(0, 80);
  return labels.length > 0 ? labels : undefined;
}

function storedStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function storedSections(value: unknown): GeneratedSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (section): section is Record<string, unknown> =>
        Boolean(section && typeof section === "object" && !Array.isArray(section))
    )
    .filter(
      (section) => typeof section.heading === "string" && typeof section.content === "string"
    )
    .map((section) => ({
      heading: (section.heading as string).trim().slice(0, 100),
      content: (section.content as string).slice(0, 20_000),
    }))
    .filter((section) => section.heading.length > 0)
    .slice(0, 8);
}

function asGeneratedSource(value: unknown): GeneratedDocSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.document_id !== "number" || !Number.isFinite(source.document_id)) {
    return null;
  }
  if (typeof source.doc !== "string" || !source.doc.trim()) return null;
  if (
    source.page !== null &&
    (typeof source.page !== "number" || !Number.isFinite(source.page))
  ) {
    return null;
  }
  return {
    document_id: source.document_id,
    doc: source.doc.trim().slice(0, 300),
    page: source.page,
  };
}

function storedSlideVisual(value: unknown): GeneratedSlideVisual | undefined {
  if (!value || typeof value !== "object") return undefined;
  const visual = value as Record<string, unknown>;
  if (!SLIDE_VISUAL_MODES.includes(visual.mode as GeneratedSlideVisual["mode"])) {
    return undefined;
  }
  const safe: GeneratedSlideVisual = { mode: visual.mode as GeneratedSlideVisual["mode"] };
  if (typeof visual.assetId === "string" && visual.assetId.trim()) {
    safe.assetId = visual.assetId.trim().slice(0, 200);
  }
  if (typeof visual.documentId === "number" && Number.isInteger(visual.documentId) && visual.documentId > 0) {
    safe.documentId = visual.documentId;
  }
  if (typeof visual.page === "number" && Number.isInteger(visual.page) && visual.page > 0) {
    safe.page = visual.page;
  }
  if (typeof visual.sourceRef === "string" && visual.sourceRef.trim()) {
    safe.sourceRef = visual.sourceRef.trim().slice(0, 300);
  }
  if (typeof visual.altText === "string" && visual.altText.trim()) {
    safe.altText = visual.altText.trim().slice(0, 300);
  }
  if (typeof visual.caption === "string" && visual.caption.trim()) {
    safe.caption = visual.caption.trim().slice(0, 200);
  }
  if (SLIDE_VISUAL_FITS.includes(visual.fit as NonNullable<GeneratedSlideVisual["fit"]>)) {
    safe.fit = visual.fit as NonNullable<GeneratedSlideVisual["fit"]>;
  }
  // imageData는 큰 런타임 데이터이므로 DB 저장본에서 절대 복원하지 않는다.
  return safe;
}

function storedSlides(value: unknown): GeneratedSlide[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (slide): slide is Record<string, unknown> =>
        Boolean(slide && typeof slide === "object" && !Array.isArray(slide))
    )
    .filter((slide) => typeof slide.title === "string" && Array.isArray(slide.bullets))
    .map((slide) => {
      const visual = storedSlideVisual(slide.visual);
      const safe: GeneratedSlide = {
        title: (slide.title as string).trim().slice(0, 200),
        bullets: storedStrings(slide.bullets, 4, 500),
        notes: typeof slide.notes === "string" ? slide.notes.slice(0, 5_000) : "",
      };
      if (
        SLIDE_LAYOUT_TYPES.includes(slide.layout as NonNullable<GeneratedSlide["layout"]>)
      ) {
        safe.layout = slide.layout as NonNullable<GeneratedSlide["layout"]>;
      }
      if (SLIDE_ROLE_TYPES.includes(slide.role as NonNullable<GeneratedSlide["role"]>)) {
        safe.role = slide.role as NonNullable<GeneratedSlide["role"]>;
      }
      if (
        SLIDE_COMPOSITION_TYPES.includes(
          slide.composition as NonNullable<GeneratedSlide["composition"]>
        )
      ) {
        safe.composition = slide.composition as NonNullable<GeneratedSlide["composition"]>;
      }
      const steps = storedStrings(slide.steps, 6, 200);
      if (steps.length > 0) safe.steps = steps;
      const sourceRefs = storedStrings(slide.sourceRefs, 20, 300);
      if (sourceRefs.length > 0) safe.sourceRefs = sourceRefs;
      if (visual) safe.visual = visual;
      return safe;
    });
}

/** PPTX 다운로드용 imageData를 제거한 뒤에만 저장 API로 전달한다. */
export function stripSlideDeckRuntimeData(deck: GeneratedSlideDeck): GeneratedSlideDeck {
  return {
    ...deck,
    mode: resolveSlideDeckMode(deck.mode),
    slides: storedSlides(deck.slides),
  };
}

/** 부분 재생성이 새로 회수한 근거를 기존 문서 근거 목록에 안전하게 합친다. */
export function mergeGeneratedSources(
  current: readonly GeneratedDocSource[] | undefined,
  incoming: unknown
): GeneratedDocSource[] {
  const candidates = [
    ...(Array.isArray(current) ? current : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ];
  const merged = new Map<string, GeneratedDocSource>();
  for (const candidate of candidates) {
    const source = asGeneratedSource(candidate);
    if (!source) continue;
    const key = `${source.document_id}::${source.page ?? "-"}::${source.doc}`;
    if (!merged.has(key)) merged.set(key, source);
    if (merged.size >= 80) break;
  }
  return Array.from(merged.values());
}

/** 저장본(SavedMaterial)을 폼 결과 상태로 복원한다(재편집 진입). */
export function hydrateMaterial(m?: SavedMaterial | null): HydratedMaterial {
  if (!m) {
    return {
      doc: null,
      deck: null,
      nlm: null,
      conditions: "",
      date: "",
      place: "",
      focus: "",
    };
  }

  const c = (m.content ?? {}) as {
    sections?: GeneratedDoc["sections"];
    slides?: GeneratedSlideDeck["slides"];
    sources?: GeneratedDoc["sources"];
    prompt?: string;
    conditions?: unknown;
    date?: unknown;
    place?: unknown;
    sourceLabels?: unknown;
    mode?: unknown;
    focus?: unknown;
    sopEvidence?: unknown;
  };
  const conditions =
    typeof c.conditions === "string"
      ? c.conditions.slice(0, MAX_GENERATION_CONDITIONS_CHARS)
      : "";
  const date = typeof c.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : "";
  const place = typeof c.place === "string" ? c.place.slice(0, 100) : "";
  const sourceLabels = storedSourceLabels(c.sourceLabels);
  const focus = typeof c.focus === "string" ? c.focus.trim().slice(0, 100) : "";
  const sopEvidence = storedSopEvidence(c.sopEvidence);

  if (m.kind === "slides") {
    return {
      doc: null,
      deck: {
        title: m.title,
        mode: resolveSlideDeckMode(c.mode),
        slides: storedSlides(c.slides),
        sources: mergeGeneratedSources([], c.sources),
        sourceLabels,
        sopEvidence,
      },
      nlm: null,
      conditions,
      date,
      place,
      focus,
    };
  }
  if (m.kind === "notebooklm") {
    return {
      doc: null,
      deck: null,
      nlm: typeof c.prompt === "string" ? c.prompt.slice(0, 100_000) : "",
      conditions,
      date,
      place,
      focus,
    };
  }
  return {
    doc: {
      title: m.title,
      sections: storedSections(c.sections),
      sources: mergeGeneratedSources([], c.sources),
      sourceLabels,
      sopEvidence,
    },
    deck: null,
    nlm: null,
    conditions,
    date,
    place,
    focus,
  };
}

/** 생성 문서를 클립보드 복사용 평문으로 편다(제목 + 섹션 + 근거 목록). */
export function docToText(doc: GeneratedDoc): string {
  const body = doc.sections.map((s) => `${s.heading}\n${s.content}`).join("\n\n");
  const sources = doc.sources.length
    ? `\n\n[근거 자료]\n${doc.sources
        .map((s) => `- ${s.doc}${s.page != null ? ` p.${s.page}` : ""}`)
        .join("\n")}`
    : "";
  return `${doc.title}\n\n${body}${sources}`;
}
