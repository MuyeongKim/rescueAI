import {
  fallbackSlideVisualMode,
  generatedSourceLabel,
  normalizedSourceLabelKey,
  type GeneratedDocSource,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { validSlideDiagram } from "@/lib/slide-diagram";
import { sourceVisualFocusRegion, validSourceVisualFocus, type SourceVisualFocus } from "@/lib/source-visual-focus";

const PDF_WORKER_PATH = "/pdf.worker.min.mjs";
const MAX_SOURCE_VISUALS_PER_DECK = 8;
const MAX_AUTOMATIC_SOURCE_VISUALS = 3;
const MAX_SOURCE_VISUAL_CANDIDATES_PER_SLIDE = 4;
const MAX_SOURCE_VISUAL_CANDIDATES_PER_DECK = 24;
const MAX_RENDER_WIDTH = 1440;
const MAX_RENDER_HEIGHT = 1080;
const MAX_RENDER_PIXELS = MAX_RENDER_WIDTH * MAX_RENDER_HEIGHT;
const JPEG_QUALITY = 0.84;
// 사전 확인과 다운로드가 같은 페이지를 사용한다. 브라우저 메모리에만 최대 8장과 그 확대 그림/2분 보관하며,
// 재사용할 때도 signedDocumentUrl로 현재 원문 접근 권한을 먼저 확인한다.
const previewImages = new Map<string, { imageData: string; score: number; expiresAt: number; sourcePath: string }>();
function cachedPreviewImage(key: string, sourceUrl: string) {
  const cached = previewImages.get(key);
  if (cached && cached.expiresAt > Date.now() && cached.sourcePath === sourceUrl.split("?")[0]) return cached;
  previewImages.delete(key);
  return undefined;
}
function rememberPreviewImage(key: string, imageData: string, score: number, sourceUrl: string) {
  previewImages.delete(key);
  while (previewImages.size >= MAX_SOURCE_VISUALS_PER_DECK * 2) {
    const oldest = previewImages.keys().next().value;
    if (oldest) previewImages.delete(oldest); else break;
  }
  previewImages.set(key, { imageData, score, expiresAt: Date.now() + 120_000, sourcePath: sourceUrl.split("?")[0] });
}

type DocumentSourceResponse = {
  url?: unknown;
  title?: unknown;
  error?: unknown;
};

export type SourceVisualProgress = {
  completed: number;
  total: number;
  title: string;
  page: number;
};

export type SourceVisualPreparation = {
  deck: GeneratedSlideDeck;
  requested: number;
  resolved: number;
  failed: number;
  fallbacks: SourceVisualFallback[];
};

export type SourceVisualFallbackReason =
  | "invalid-metadata"
  | "source-unavailable"
  | "page-out-of-range"
  | "text-only-page"
  | "render-failed";

export type SourceVisualFallback = {
  slideIndex: number;
  title: string;
  reason: SourceVisualFallbackReason;
};

export type SourceVisualCandidate = {
  documentId: number;
  page: number;
  documentTitle: string;
  sourceRef?: string;
};

export type SourceVisualRequest = {
  slideIndex: number;
  documentId: number;
  page: number;
  title: string;
  candidates: SourceVisualCandidate[];
  sourceFocus?: SourceVisualFocus;
};

type RejectedVisualRequest = {
  slideIndex: number;
  page: number;
  title: string;
  reason: "invalid-metadata";
};

export type SourceVisualRequestPlan = {
  deck: GeneratedSlideDeck;
  requests: SourceVisualRequest[];
  rejected: RejectedVisualRequest[];
  requested: number;
};

type VerifiedSource = {
  source: GeneratedDocSource;
  label: string;
  pageKey: string;
};

type AutomaticSourceVisualCandidate = {
  slideIndex: number;
  priority: number;
  sources: VerifiedSource[];
};

export type SourcePageVisualSignals = {
  imageOperations: number;
  formOperations: number;
  vectorOperations: number;
  shadingOperations: number;
  textCharacters: number;
};

/** PDF 페이지가 사진·도해·표로 쓸 가치가 있는지 비교하기 위한 보수적 점수. */
export function sourcePageVisualScore(signals: SourcePageVisualSignals): number {
  const graphicScore =
    Math.min(signals.imageOperations, 6) * 90 +
    Math.min(signals.formOperations, 8) * 26 +
    Math.min(signals.shadingOperations, 6) * 32 +
    Math.min(signals.vectorOperations, 120) * 1.4;
  const textPenalty = Math.max(0, signals.textCharacters - 1_600) / 45;
  return Math.round((graphicScore - textPenalty) * 10) / 10;
}

/** 명확한 그림 연산이 없고 텍스트만 많은 페이지 스크린샷은 PPT에 넣지 않는다. */
export function isUsefulSourcePageVisual(signals: SourcePageVisualSignals): boolean {
  if (
    (signals.imageOperations > 0 ||
      signals.formOperations > 0 ||
      signals.shadingOperations > 0) &&
    signals.textCharacters <= 1_800
  ) {
    return true;
  }
  // 일부 PDF는 글자 자체를 수백 개의 벡터 경로로 저장한다. 따라서 경로 수가 많아도
  // 본문이 긴 페이지는 그림·표로 보지 않고, 발표 화면에서 읽을 수 있는 분량만 허용한다.
  return signals.vectorOperations >= 8 && signals.textCharacters <= 1_200;
}

function verifiedSourcesByLabel(
  sources: readonly GeneratedDocSource[]
): Map<string, VerifiedSource> {
  const candidates = new Map<string, Map<string, VerifiedSource>>();

  for (const source of sources) {
    if (
      !Number.isSafeInteger(source.document_id) ||
      source.document_id <= 0 ||
      typeof source.doc !== "string" ||
      !source.doc.trim() ||
      source.page == null ||
      !Number.isSafeInteger(source.page) ||
      source.page <= 0
    ) {
      continue;
    }

    const normalized: GeneratedDocSource = {
      document_id: source.document_id,
      doc: source.doc.trim(),
      page: source.page,
    };
    const label = generatedSourceLabel(normalized);
    const labelKey = normalizedSourceLabelKey(label);
    const pageKey = `${normalized.document_id}:${normalized.page}`;
    const byIdentity = candidates.get(labelKey) ?? new Map<string, VerifiedSource>();
    if (!byIdentity.has(pageKey)) {
      byIdentity.set(pageKey, { source: normalized, label, pageKey });
    }
    candidates.set(labelKey, byIdentity);
  }

  const verified = new Map<string, VerifiedSource>();
  candidates.forEach((byIdentity, label) => {
    // 같은 표시 라벨이 서로 다른 실제 문서·페이지를 가리키면 어느 쪽도 추정하지 않는다.
    if (byIdentity.size !== 1) return;
    const source = byIdentity.values().next().value;
    if (source) verified.set(label, source);
  });
  return verified;
}

function automaticVisualPriority(slide: GeneratedSlide): number | null {
  if (slide.composition === "visual-explanation") return 0;
  if (slide.role === "evidence") return 1;
  if (slide.role === "equipment") return 2;
  const visualCueText = `${slide.title} ${slide.bullets.join(" ")}`;
  if (
    (slide.role === "case" || slide.role === "procedure" || slide.role === "concept") &&
    /(사진|도해|모식도|단면|구성품|부위|착용\s*자세|장비\s*외관|배치|위험\s*구역|통제\s*구역|그림에서|표에서)/.test(
      visualCueText
    )
  ) {
    return slide.role === "case" ? 3 : 4;
  }
  return null;
}

/**
 * 각 장의 정확한 sourceRefs와 서버가 검증해 덱에 보관한 sources를 교차 확인해
 * 원문 페이지를 최대 3장까지 연결한다. 기존 선택과 기본 다이어그램은 유지하고,
 * 남은 자리만 채우며 같은 원문 페이지는 반복하지 않는다.
 */
export function autoAssignDeckSourceVisuals(
  deck: GeneratedSlideDeck,
  maxVisuals = MAX_AUTOMATIC_SOURCE_VISUALS
): GeneratedSlideDeck {
  const existingSourceVisuals = deck.slides.filter(
    (slide) => slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop"
  );
  const limit = Math.min(
    MAX_AUTOMATIC_SOURCE_VISUALS,
    Math.max(0, Number.isFinite(maxVisuals) ? Math.floor(maxVisuals) : 0)
  );
  const remaining = Math.max(0, limit - existingSourceVisuals.length);
  if (remaining === 0) return deck;

  const sourceByLabel = verifiedSourcesByLabel(deck.sources);
  if (sourceByLabel.size === 0) return deck;

  const candidates: AutomaticSourceVisualCandidate[] = [];
  deck.slides.forEach((slide, slideIndex) => {
    const priority = automaticVisualPriority(slide);
    const isExistingSource =
      slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop";
    if (priority === null || isExistingSource || slide.visual?.mode === "native-diagram" || validSlideDiagram(slide)) return;

    const slideSources = new Map<string, VerifiedSource>();
    for (const rawRef of slide.sourceRefs ?? []) {
      if (typeof rawRef !== "string") continue;
      const source = sourceByLabel.get(normalizedSourceLabelKey(rawRef));
      if (source && !slideSources.has(source.pageKey)) {
        slideSources.set(source.pageKey, source);
      }
    }
    if (slideSources.size > 0) {
      candidates.push({ slideIndex, priority, sources: Array.from(slideSources.values()) });
    }
  });
  if (candidates.length === 0) return deck;

  candidates.sort((left, right) => left.priority - right.priority || left.slideIndex - right.slideIndex);

  // 선택지가 적은 문서를 먼저 배정하면 뒤의 장에서도 서로 다른 문서를 쓸 가능성이 높아진다.
  const documentCandidateFrequency = new Map<number, number>();
  for (const candidate of candidates) {
    const documentIds = new Set(candidate.sources.map(({ source }) => source.document_id));
    documentIds.forEach((documentId) => {
      documentCandidateFrequency.set(
        documentId,
        (documentCandidateFrequency.get(documentId) ?? 0) + 1
      );
    });
  }
  for (const candidate of candidates) {
    candidate.sources.sort((left, right) => {
      const frequencyDifference =
        (documentCandidateFrequency.get(left.source.document_id) ?? 0) -
        (documentCandidateFrequency.get(right.source.document_id) ?? 0);
      return frequencyDifference;
    });
  }

  const selected = new Map<number, VerifiedSource>();
  const usedDocumentIds = new Set<number>();
  const usedPages = new Set<string>();
  for (const slide of existingSourceVisuals) {
    const documentId = slide.visual?.documentId;
    const page = slide.visual?.page;
    if (!Number.isSafeInteger(documentId) || !Number.isSafeInteger(page)) continue;
    usedDocumentIds.add(documentId as number);
    usedPages.add(`${documentId}:${page}`);
  }

  // 먼저 서로 다른 문서를 배정하고, 자리가 남을 때만 같은 문서의 다른 페이지를 사용한다.
  for (const candidate of candidates) {
    if (selected.size >= remaining) break;
    const source = candidate.sources.find(
      (item) => !usedDocumentIds.has(item.source.document_id) && !usedPages.has(item.pageKey)
    );
    if (!source) continue;
    selected.set(candidate.slideIndex, source);
    usedDocumentIds.add(source.source.document_id);
    usedPages.add(source.pageKey);
  }
  for (const candidate of candidates) {
    if (selected.size >= remaining) break;
    if (selected.has(candidate.slideIndex)) continue;
    const source = candidate.sources.find((item) => !usedPages.has(item.pageKey));
    if (!source) continue;
    selected.set(candidate.slideIndex, source);
    usedPages.add(source.pageKey);
  }
  if (selected.size === 0) return deck;

  return {
    ...deck,
    slides: deck.slides.map((slide, slideIndex) => {
      const selectedSource = selected.get(slideIndex);
      if (!selectedSource) return slide;
      const { source, label } = selectedSource;
      return {
        ...slide,
        composition: "visual-explanation",
        diagram: undefined,
        visual: {
          mode: "source-page",
          documentId: source.document_id,
          page: source.page ?? undefined,
          sourceRef: label,
          altText: `${source.doc} ${source.page}쪽 원문 페이지`,
          caption: label,
          fit: "contain",
        },
      };
    }),
  };
}

async function signedDocumentUrl(documentId: number): Promise<{ url: string; title: string }> {
  const response = await fetch(`/api/documents/${documentId}/source`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = (await response.json().catch(() => null)) as DocumentSourceResponse | null;
  if (!response.ok || typeof payload?.url !== "string" || !payload.url) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : "원본 PDF 주소를 준비하지 못했습니다.";
    throw new Error(message);
  }
  return {
    url: payload.url,
    title: typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : `자료 ${documentId}`,
  };
}

/** 원문 페이지를 쓸 수 없을 때 자리표시자를 남기지 않고 의미에 맞는 구도로 복구한다. */
export function fallbackSourceVisualSlide(slide: GeneratedSlide): GeneratedSlide {
  const steps = (slide.steps ?? []).filter((step) => step.trim());
  const composition =
    slide.role === "comparison" && steps.length === 2
      ? "comparison"
      : slide.role === "decision" && steps.length >= 3 && steps.length <= 5
        ? "decision-flow"
        : slide.role === "timeline" && steps.length >= 3 && steps.length <= 5
          ? "timeline"
          : slide.role === "procedure" && steps.length >= 3 && steps.length <= 5
            ? "process"
            : (slide.role === "equipment" || slide.role === "safety")
              ? "checklist"
              : slide.role === "case"
                ? "scenario"
                : slide.role === "summary"
                  ? "summary"
                  : steps.length === 2 && slide.bullets.length >= 2
                    ? "comparison"
                    : steps.length >= 3 && steps.length <= 5
                      ? "process"
                      : "list";
  const layout =
    composition === "process" || composition === "timeline" || composition === "decision-flow"
      ? "process"
      : composition === "checklist"
        ? slide.role === "equipment"
          ? "equipment"
          : "safety"
        : composition === "scenario"
          ? "case"
          : composition === "summary"
            ? "summary"
            : "concept";
  const fallbackBase: GeneratedSlide = { ...slide, composition, layout };
  // 그림 구도의 오래된 연결이 우연히 새 구도와 맞아도 되살리지 않는다.
  if (!validSlideDiagram(slide) || !validSlideDiagram(fallbackBase)) delete fallbackBase.diagram;
  return {
    ...fallbackBase,
    visual: {
      mode: fallbackSlideVisualMode(fallbackBase),
      altText: slide.visual?.altText,
      caption: slide.visual?.caption,
    },
  };
}

function candidateKey(candidate: SourceVisualCandidate): string {
  return `${candidate.documentId}:${candidate.page}`;
}

function sourceVisualCandidates(
  slide: GeneratedSlide,
  sourceByLabel: ReadonlyMap<string, VerifiedSource>
): SourceVisualCandidate[] {
  const visual = slide.visual;
  if (!visual) return [];
  const candidates = new Map<string, SourceVisualCandidate>();
  const addVerified = (verified: VerifiedSource) => {
    const candidate: SourceVisualCandidate = {
      documentId: verified.source.document_id,
      page: verified.source.page as number,
      documentTitle: verified.source.doc,
      sourceRef: verified.label,
    };
    candidates.set(candidateKey(candidate), candidate);
  };

  const primaryRef = visual.sourceRef?.trim();
  const primary = primaryRef
    ? sourceByLabel.get(normalizedSourceLabelKey(primaryRef))
    : undefined;
  if (primary) addVerified(primary);

  for (const rawRef of slide.sourceRefs ?? []) {
    const source = sourceByLabel.get(normalizedSourceLabelKey(rawRef));
    if (source) addVerified(source);
    if (candidates.size >= MAX_SOURCE_VISUAL_CANDIDATES_PER_SLIDE) break;
  }

  // 과거 저장본처럼 sources가 비어 있는 경우에만 기존 숫자 메타데이터를 제한적으로 사용한다.
  if (
    candidates.size === 0 &&
    sourceByLabel.size === 0 &&
    Number.isSafeInteger(visual.documentId) &&
    (visual.documentId ?? 0) > 0 &&
    Number.isSafeInteger(visual.page) &&
    (visual.page ?? 0) > 0
  ) {
    const legacy: SourceVisualCandidate = {
      documentId: visual.documentId as number,
      page: visual.page as number,
      documentTitle: visual.altText?.trim() || "원본 자료",
      sourceRef: primaryRef,
    };
    candidates.set(candidateKey(legacy), legacy);
  }

  return Array.from(candidates.values()).slice(0, MAX_SOURCE_VISUAL_CANDIDATES_PER_SLIDE);
}

/** 저장본의 과거 source-crop도 전체 페이지로 정규화하고, 처리 불가 요청은 즉시 폴백한다. */
export function planSourceVisualRequests(deck: GeneratedSlideDeck): SourceVisualRequestPlan {
  const requests: SourceVisualRequest[] = [];
  const rejected: RejectedVisualRequest[] = [];
  let requested = 0;
  let candidateCount = 0;
  const sourceByLabel = verifiedSourcesByLabel(deck.sources);

  const slides = deck.slides.map((slide, slideIndex) => {
    const visual = slide.visual;
    if (!visual || (visual.mode !== "source-page" && visual.mode !== "source-crop")) {
      return slide;
    }
    requested += 1;
    const normalizedSlide: GeneratedSlide = {
      ...slide,
      visual: { ...visual, mode: "source-page", sourceFocus: validSourceVisualFocus(visual.sourceFocus) },
    };
    const candidates = sourceVisualCandidates(slide, sourceByLabel);
    const primary = candidates[0];
    const metadataMatchesPrimary =
      !primary ||
      ((visual.documentId === undefined || visual.documentId === primary.documentId) &&
        (visual.page === undefined || visual.page === primary.page));
    const page = primary?.page ?? (Number.isSafeInteger(visual.page) ? (visual.page as number) : 0);
    const validMetadata =
      slide.composition === "visual-explanation" &&
      Boolean(primary) &&
      metadataMatchesPrimary;

    if (!validMetadata || requests.length >= MAX_SOURCE_VISUALS_PER_DECK) {
      rejected.push({ slideIndex, page, title: slide.title, reason: "invalid-metadata" });
      return fallbackSourceVisualSlide(normalizedSlide);
    }

    const availableCandidateSlots = MAX_SOURCE_VISUAL_CANDIDATES_PER_DECK - candidateCount;
    if (availableCandidateSlots <= 0) {
      rejected.push({ slideIndex, page, title: slide.title, reason: "invalid-metadata" });
      return fallbackSourceVisualSlide(normalizedSlide);
    }
    const futureRequestReserve = Math.max(
      0,
      MAX_SOURCE_VISUALS_PER_DECK - requests.length - 1
    );
    const currentCandidateSlots = Math.max(
      1,
      availableCandidateSlots - futureRequestReserve
    );
    const boundedCandidates = candidates.slice(
      0,
      Math.min(MAX_SOURCE_VISUAL_CANDIDATES_PER_SLIDE, currentCandidateSlots)
    );
    candidateCount += boundedCandidates.length;

    requests.push({
      slideIndex,
      documentId: primary!.documentId,
      page,
      title: slide.title,
      candidates: boundedCandidates,
      sourceFocus: validSourceVisualFocus(visual.sourceFocus),
    });
    return normalizedSlide;
  });

  return { deck: { ...deck, slides }, requests, rejected, requested };
}

/** 원문 페이지 번호가 실제 PDF 범위와 정확히 일치할 때만 사용한다. */
export function exactPdfPageNumber(requestedPage: number, totalPages: number): number | null {
  return Number.isSafeInteger(requestedPage) &&
    requestedPage > 0 &&
    Number.isSafeInteger(totalPages) &&
    totalPages > 0 &&
    requestedPage <= totalPages
    ? requestedPage
    : null;
}

type PdfPageForVisualInspection = {
  getOperatorList: () => Promise<{ fnArray: readonly number[] }>;
  getTextContent: () => Promise<{ items: readonly unknown[] }>;
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    background: string;
    transform?: number[];
  }) => { promise: Promise<unknown> };
  cleanup: () => void;
};

function numericOperations(
  operations: Record<string, number>,
  names: readonly string[]
): Set<number> {
  return new Set(
    names
      .map((name) => operations[name])
      .filter((value): value is number => Number.isFinite(value))
  );
}

async function inspectSourcePdfPage(
  page: PdfPageForVisualInspection,
  operations: Record<string, number>
): Promise<SourcePageVisualSignals> {
  const [operatorList, textContent] = await Promise.all([
    page.getOperatorList(),
    page.getTextContent(),
  ]);
  const imageOps = numericOperations(operations, [
    "paintImageMaskXObject",
    "paintImageMaskXObjectGroup",
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintInlineImageXObjectGroup",
    "paintImageXObjectRepeat",
    "paintImageMaskXObjectRepeat",
    "paintSolidColorImageMask",
  ]);
  const formOps = numericOperations(operations, ["paintXObject", "paintFormXObjectBegin"]);
  const vectorOps = numericOperations(operations, [
    "constructPath",
    "stroke",
    "closeStroke",
    "fill",
    "eoFill",
    "fillStroke",
    "eoFillStroke",
    "closeFillStroke",
    "closeEOFillStroke",
  ]);
  const shadingOps = numericOperations(operations, ["shadingFill"]);
  const count = (set: ReadonlySet<number>) =>
    operatorList.fnArray.reduce((total, operation) => total + (set.has(operation) ? 1 : 0), 0);
  const textCharacters = textContent.items.reduce<number>((total, item) => {
    const text =
      item && typeof item === "object" && "str" in item
        ? (item as { str?: unknown }).str
        : undefined;
    return total + (typeof text === "string" ? text.replace(/\s+/g, "").length : 0);
  }, 0);

  return {
    imageOperations: count(imageOps),
    formOperations: count(formOps),
    vectorOperations: count(vectorOps),
    shadingOperations: count(shadingOps),
    textCharacters,
  };
}

async function renderSourcePdfPage(page: PdfPageForVisualInspection, focus?: SourceVisualFocus): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(base.width) ||
    !Number.isFinite(base.height) ||
    base.width <= 0 ||
    base.height <= 0
  ) {
    throw new Error("PDF 페이지 크기가 올바르지 않습니다.");
  }
  const region = sourceVisualFocusRegion(focus);
  const regionWidth = base.width * region.width;
  const regionHeight = base.height * region.height;
  const pixelScale = Math.sqrt(MAX_RENDER_PIXELS / (regionWidth * regionHeight));
  // 작은 보통 문서는 최대 2배까지 선명하게, 비정상적으로 큰 MediaBox는 반드시 축소한다.
  const scale = Math.max(
    Number.EPSILON,
    Math.min(
      2,
      MAX_RENDER_WIDTH / regionWidth,
      MAX_RENDER_HEIGHT / regionHeight,
      pixelScale
    )
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.min(MAX_RENDER_WIDTH, Math.ceil(viewport.width * region.width)));
  canvas.height = Math.max(1, Math.min(MAX_RENDER_HEIGHT, Math.ceil(viewport.height * region.height)));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("PDF 페이지 렌더링 화면을 만들지 못했습니다.");
  try {
    await page.render({ canvasContext: context, viewport, background: "#FFFFFF",
      ...(focus ? { transform: [1, 0, 0, 1, -viewport.width * region.x, -viewport.height * region.y] } : {}),
    }).promise;
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

/**
 * 비공개 원본 PDF의 필요한 페이지만 브라우저에서 래스터 이미지로 만든다.
 * 서명 URL과 imageData는 저장하지 않고 PPTX 다운로드 직전 메모리에서만 사용한다.
 */
export async function prepareDeckSourceVisuals(
  deck: GeneratedSlideDeck,
  onProgress?: (progress: SourceVisualProgress) => void
): Promise<SourceVisualPreparation> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { deck, requested: 0, resolved: 0, failed: 0, fallbacks: [] };
  }

  const plan = planSourceVisualRequests(deck);
  if (plan.requested === 0) {
    return { deck: plan.deck, requested: 0, resolved: 0, failed: 0, fallbacks: [] };
  }

  let completed = 0;
  const fallbackBySlide = new Map<number, SourceVisualFallback>(
    plan.rejected.map((item) => [
      item.slideIndex,
      {
        slideIndex: item.slideIndex,
        title: item.title,
        reason: item.reason,
      },
    ])
  );
  for (const rejected of plan.rejected) {
    completed += 1;
    onProgress?.({
      completed,
      total: plan.requested,
      title: rejected.title,
      page: rejected.page,
    });
  }
  if (plan.requests.length === 0) {
    return {
      deck: plan.deck,
      requested: plan.requested,
      resolved: 0,
      failed: plan.requested,
      fallbacks: Array.from(fallbackBySlide.values()),
    };
  }

  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;

  const allCandidates = Array.from(
    new Map(
      plan.requests
        .flatMap((request) => request.candidates)
        .map((candidate) => [candidateKey(candidate), candidate] as const)
    ).values()
  );
  const documentIds = Array.from(new Set(allCandidates.map((item) => item.documentId)));
  const signedSources = new Map<number, { url: string; title: string }>();
  const sourceResults = await Promise.allSettled(
    documentIds.map(async (documentId) => {
      const source = await signedDocumentUrl(documentId);
      signedSources.set(documentId, source);
    })
  );
  const unavailableDocuments = new Set<number>();
  sourceResults.forEach((result, index) => {
    if (result.status === "rejected") unavailableDocuments.add(documentIds[index]);
  });

  type EvaluatedCandidate = {
    candidate: SourceVisualCandidate;
    score: number;
    failure?: Exclude<SourceVisualFallbackReason, "invalid-metadata">;
  };
  const evaluatedByPage = new Map<string, EvaluatedCandidate>();

  for (const documentId of documentIds) {
    const source = signedSources.get(documentId);
    const documentCandidates = allCandidates.filter((item) => item.documentId === documentId);
    if (!source || unavailableDocuments.has(documentId)) {
      for (const candidate of documentCandidates) {
        evaluatedByPage.set(candidateKey(candidate), {
          candidate,
          score: Number.NEGATIVE_INFINITY,
          failure: "source-unavailable",
        });
      }
      continue;
    }

    const cachedCandidates = documentCandidates.map((candidate) => ({ candidate, cached: cachedPreviewImage(candidateKey(candidate), source.url) }));
    if (cachedCandidates.every(({ cached }) => cached)) {
      for (const { candidate, cached } of cachedCandidates) {
        evaluatedByPage.set(candidateKey(candidate), {
          candidate, score: cached!.score,
        });
      }
      continue;
    }

    let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
    try {
      pdf = await pdfjs.getDocument({ url: source.url }).promise;
      for (const candidate of documentCandidates) {
        const key = candidateKey(candidate);
        const cached = cachedPreviewImage(key, source.url);
        if (cached) {
          evaluatedByPage.set(key, { candidate, score: cached.score });
          continue;
        }
        let page: PdfPageForVisualInspection | null = null;
        try {
          const pageNumber = exactPdfPageNumber(candidate.page, pdf.numPages);
          if (pageNumber === null) {
            evaluatedByPage.set(key, {
              candidate,
              score: Number.NEGATIVE_INFINITY,
              failure: "page-out-of-range",
            });
            continue;
          }
          page = (await pdf.getPage(pageNumber)) as unknown as PdfPageForVisualInspection;
          let signals: SourcePageVisualSignals | null = null;
          try {
            signals = await inspectSourcePdfPage(
              page,
              pdfjs.OPS as unknown as Record<string, number>
            );
          } catch {
            // 일부 오래된 PDF는 연산 목록 분석만 실패할 수 있으므로 실제 렌더는 계속 시도한다.
          }
          if (signals && !isUsefulSourcePageVisual(signals)) {
            evaluatedByPage.set(key, {
              candidate,
              score: sourcePageVisualScore(signals),
              failure: "text-only-page",
            });
          } else {
            evaluatedByPage.set(key, {
              candidate,
              score: signals ? sourcePageVisualScore(signals) : 0,
            });
          }
        } catch {
          evaluatedByPage.set(key, {
            candidate,
            score: Number.NEGATIVE_INFINITY,
            failure: "render-failed",
          });
        } finally {
          page?.cleanup();
        }
      }
    } catch {
      for (const candidate of documentCandidates) {
        evaluatedByPage.set(candidateKey(candidate), {
          candidate,
          score: Number.NEGATIVE_INFINITY,
          failure: "source-unavailable",
        });
      }
    } finally {
      await pdf?.destroy();
    }
  }

  // 1차 분석 결과로 장별 후보를 고른 뒤, 실제 JPEG 렌더링은 선택된 페이지만 수행한다.
  // 따라서 후보가 24개여도 캔버스/data URL은 출력할 최대 8장만 메모리에 존재한다.
  const selectedCandidateBySlide = new Map<number, EvaluatedCandidate>();
  for (const request of plan.requests) {
    const evaluated = request.candidates
      .map((candidate, order) => ({ item: evaluatedByPage.get(candidateKey(candidate)), order }))
      .filter(
        (entry): entry is { item: EvaluatedCandidate; order: number } => Boolean(entry.item)
      );
    const usable = evaluated
      .filter(({ item }) => !item.failure)
      .sort((left, right) => right.item.score - left.item.score || left.order - right.order);
    // 사용자가 고른 원문을 우선한다. 장 순서/다른 장의 선택 때문에 사전 확인한 그림이 바뀌지 않는다.
    const selected = usable.find(({ item }) =>
      item.candidate.documentId === request.documentId && item.candidate.page === request.page
    )?.item ?? usable[0]?.item;
    if (selected) {
      selectedCandidateBySlide.set(request.slideIndex, selected);
    } else {
      const failure =
        evaluated.find(({ item }) => item.failure === "text-only-page")?.item.failure ??
        evaluated.find(({ item }) => item.failure === "page-out-of-range")?.item.failure ??
        evaluated.find(({ item }) => item.failure === "source-unavailable")?.item.failure ??
        "render-failed";
      fallbackBySlide.set(request.slideIndex, {
        slideIndex: request.slideIndex,
        title: request.title,
        reason: failure,
      });
    }
  }

  const selectedPages = Array.from(
    new Map(
      Array.from(selectedCandidateBySlide.values()).map((item) => [
        candidateKey(item.candidate),
        item.candidate,
      ] as const)
    ).values()
  );
  const renderedByPage = new Map<string, string>();
  const focusByPage = new Map<string, Set<SourceVisualFocus>>();
  const renderedFocus = new Map<string, string>();
  const focusedKey = (candidate: SourceVisualCandidate, focus: SourceVisualFocus) => `${candidateKey(candidate)}:${focus}`;
  for (const request of plan.requests) {
    const selected = selectedCandidateBySlide.get(request.slideIndex)?.candidate;
    // 대체 원문으로 바뀌었으면 예전 페이지의 확대 범위를 적용하지 않는다.
    if (!selected || !request.sourceFocus || selected.documentId !== request.documentId || selected.page !== request.page) continue;
    const key = candidateKey(selected);
    const focuses = focusByPage.get(key) ?? new Set<SourceVisualFocus>();
    focuses.add(request.sourceFocus);
    focusByPage.set(key, focuses);
  }
  for (const candidate of selectedPages) {
    const source = signedSources.get(candidate.documentId);
    const cached = source ? cachedPreviewImage(candidateKey(candidate), source.url) : undefined;
    if (cached) renderedByPage.set(candidateKey(candidate), cached.imageData);
    for (const focus of focusByPage.get(candidateKey(candidate)) ?? []) {
      const cachedFocus = source ? cachedPreviewImage(focusedKey(candidate, focus), source.url) : undefined;
      if (cachedFocus) renderedFocus.set(focusedKey(candidate, focus), cachedFocus.imageData);
    }
  }
  const selectedDocumentIds = Array.from(
    new Set(selectedPages.map((candidate) => candidate.documentId))
  );

  for (const documentId of selectedDocumentIds) {
    const source = signedSources.get(documentId);
    const selectedDocumentPages = selectedPages.filter(
      (candidate) => candidate.documentId === documentId && (!renderedByPage.has(candidateKey(candidate)) ||
        [...(focusByPage.get(candidateKey(candidate)) ?? [])].some((focus) => !renderedFocus.has(focusedKey(candidate, focus))))
    );
    if (!source || selectedDocumentPages.length === 0) continue;
    let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
    try {
      pdf = await pdfjs.getDocument({ url: source.url }).promise;
      for (const candidate of selectedDocumentPages) {
        let page: PdfPageForVisualInspection | null = null;
        try {
          const pageNumber = exactPdfPageNumber(candidate.page, pdf.numPages);
          if (pageNumber === null) continue;
          page = (await pdf.getPage(pageNumber)) as unknown as PdfPageForVisualInspection;
          const score = evaluatedByPage.get(candidateKey(candidate))?.score ?? 0;
          if (!renderedByPage.has(candidateKey(candidate))) {
            const imageData = await renderSourcePdfPage(page);
            renderedByPage.set(candidateKey(candidate), imageData);
            rememberPreviewImage(candidateKey(candidate), imageData, score, source.url);
          }
          for (const focus of focusByPage.get(candidateKey(candidate)) ?? []) {
            const key = focusedKey(candidate, focus);
            if (renderedFocus.has(key)) continue;
            const imageData = await renderSourcePdfPage(page, focus);
            renderedFocus.set(key, imageData);
            rememberPreviewImage(key, imageData, score, source.url);
          }
        } catch {
          // 해당 슬라이드는 아래에서 안전한 편집 도형·내용 구도로 폴백한다.
        } finally {
          page?.cleanup();
        }
      }
    } catch {
      // 서명 URL이 만료되거나 PDF를 다시 열지 못하면 선택된 해당 문서 페이지만 폴백한다.
    } finally {
      await pdf?.destroy();
    }
  }

  const selectedBySlide = new Map<number, EvaluatedCandidate & { imageData: string; sourcePageImageData?: string; sourceFocus?: SourceVisualFocus }>();
  for (const request of plan.requests) {
    const selected = selectedCandidateBySlide.get(request.slideIndex);
    const imageData = selected
      ? renderedByPage.get(candidateKey(selected.candidate))
      : undefined;
    if (selected && imageData) {
      const focus = request.sourceFocus && selected.candidate.documentId === request.documentId && selected.candidate.page === request.page
        ? request.sourceFocus : undefined;
      const focusImage = focus ? renderedFocus.get(focusedKey(selected.candidate, focus)) : undefined;
      if (focus && !focusImage) {
        // 선택한 확대 그림을 확인하지 못한 상태로 다른 범위의 그림을 내보내지 않는다.
        fallbackBySlide.set(request.slideIndex, { slideIndex: request.slideIndex, title: request.title, reason: "render-failed" });
      } else {
        selectedBySlide.set(request.slideIndex, { ...selected, imageData: focusImage ?? imageData,
          ...(focusImage ? { sourceFocus: focus, sourcePageImageData: imageData } : {}),
        });
      }
    } else if (selected) {
      fallbackBySlide.set(request.slideIndex, {
        slideIndex: request.slideIndex,
        title: request.title,
        reason: "render-failed",
      });
    }
    completed += 1;
    onProgress?.({
      completed,
      total: plan.requested,
      title: request.title,
      page: selected?.candidate.page ?? request.page,
    });
  }

  const preparedDeck: GeneratedSlideDeck = {
    ...plan.deck,
    slides: plan.deck.slides.map((slide, slideIndex) => {
      const selected = selectedBySlide.get(slideIndex);
      if (selected?.imageData && slide.visual) {
        const candidate = selected.candidate;
        const sameSource =
          Boolean(slide.visual.sourceRef && candidate.sourceRef) &&
          normalizedSourceLabelKey(slide.visual.sourceRef as string) ===
            normalizedSourceLabelKey(candidate.sourceRef as string);
        return {
          ...slide,
          visual: {
            mode: "source-page",
            documentId: candidate.documentId,
            page: candidate.page,
            sourceRef: candidate.sourceRef,
            altText:
              (sameSource ? slide.visual.altText?.trim() : "") ||
              `${candidate.documentTitle} ${candidate.page}쪽 원문 페이지`,
            caption:
              (sameSource ? slide.visual.caption?.trim() : "") || candidate.sourceRef,
            fit: "contain",
            imageData: selected.imageData,
            sourceFocus: selected.sourceFocus,
            sourcePageImageData: selected.sourcePageImageData,
          },
        };
      }
      if (fallbackBySlide.has(slideIndex)) return fallbackSourceVisualSlide(slide);
      return slide;
    }),
  };

  const fallbacks = Array.from(fallbackBySlide.values()).sort(
    (left, right) => left.slideIndex - right.slideIndex
  );

  return {
    deck: preparedDeck,
    requested: plan.requested,
    resolved: selectedBySlide.size,
    failed: Math.max(0, plan.requested - selectedBySlide.size),
    fallbacks,
  };
}
