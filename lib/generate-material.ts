// 생성물 ↔ 폼 상태 변환 (순수 함수, 클라이언트/서버 공용).
// UI(components/generate/*)에서 분리해 두면 저장본 복원 규칙을 테스트로 고정할 수 있다.
import {
  AUDIENCES,
  DURATIONS,
  MAX_GENERATION_CONDITIONS_CHARS,
  type Audience,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedDocSource,
  type GeneratedSlideDeck,
  type SavedMaterial,
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
};

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
    return { doc: null, deck: null, nlm: null, conditions: "", date: "", place: "" };
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
  };
  const conditions =
    typeof c.conditions === "string"
      ? c.conditions.slice(0, MAX_GENERATION_CONDITIONS_CHARS)
      : "";
  const date = typeof c.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : "";
  const place = typeof c.place === "string" ? c.place.slice(0, 100) : "";
  const sourceLabels = storedSourceLabels(c.sourceLabels);

  if (m.kind === "slides") {
    return {
      doc: null,
      deck: {
        title: m.title,
        slides: c.slides ?? [],
        sources: c.sources ?? [],
        sourceLabels,
      },
      nlm: null,
      conditions,
      date,
      place,
    };
  }
  if (m.kind === "notebooklm") {
    return { doc: null, deck: null, nlm: c.prompt ?? "", conditions, date, place };
  }
  return {
    doc: {
      title: m.title,
      sections: c.sections ?? [],
      sources: c.sources ?? [],
      sourceLabels,
    },
    deck: null,
    nlm: null,
    conditions,
    date,
    place,
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
