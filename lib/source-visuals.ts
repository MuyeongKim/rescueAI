import {
  fallbackSlideVisualMode,
  generatedSourceLabel,
  type GeneratedDocSource,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";

const PDF_WORKER_PATH = "/pdf.worker.min.mjs";
const MAX_SOURCE_VISUALS_PER_DECK = 8;
const MAX_AUTOMATIC_SOURCE_VISUALS = 3;
const MAX_RENDER_WIDTH = 1440;
const MAX_RENDER_HEIGHT = 1080;
const JPEG_QUALITY = 0.84;

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
};

export type SourceVisualRequest = {
  slideIndex: number;
  documentId: number;
  page: number;
  title: string;
};

type RejectedVisualRequest = {
  slideIndex: number;
  page: number;
  title: string;
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
    const pageKey = `${normalized.document_id}:${normalized.page}`;
    const byIdentity = candidates.get(label) ?? new Map<string, VerifiedSource>();
    if (!byIdentity.has(pageKey)) {
      byIdentity.set(pageKey, { source: normalized, label, pageKey });
    }
    candidates.set(label, byIdentity);
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
  return null;
}

/**
 * LLM이 원문 페이지를 한 장도 선택하지 않았을 때만, 각 장의 정확한 sourceRefs와
 * 서버가 검증해 덱에 보관한 sources를 교차 확인해 최대 3장의 전체 원문 페이지를 연결한다.
 * 이미 선택된 원문·기본 다이어그램은 유지하고, 같은 원문 페이지는 반복하지 않는다.
 */
export function autoAssignDeckSourceVisuals(
  deck: GeneratedSlideDeck,
  maxVisuals = MAX_AUTOMATIC_SOURCE_VISUALS
): GeneratedSlideDeck {
  const alreadyHasSourceVisual = deck.slides.some(
    (slide) => slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop"
  );
  if (alreadyHasSourceVisual) return deck;

  const limit = Math.min(
    MAX_AUTOMATIC_SOURCE_VISUALS,
    Math.max(0, Number.isFinite(maxVisuals) ? Math.floor(maxVisuals) : 0)
  );
  if (limit === 0) return deck;

  const sourceByLabel = verifiedSourcesByLabel(deck.sources);
  if (sourceByLabel.size === 0) return deck;

  const candidates: AutomaticSourceVisualCandidate[] = [];
  deck.slides.forEach((slide, slideIndex) => {
    const priority = automaticVisualPriority(slide);
    if (priority === null || slide.visual?.mode === "native-diagram") return;

    const slideSources = new Map<string, VerifiedSource>();
    for (const rawRef of slide.sourceRefs ?? []) {
      if (typeof rawRef !== "string") continue;
      const source = sourceByLabel.get(rawRef.trim());
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

  // 먼저 서로 다른 문서를 배정하고, 자리가 남을 때만 같은 문서의 다른 페이지를 사용한다.
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
    const source = candidate.sources.find(
      (item) => !usedDocumentIds.has(item.source.document_id) && !usedPages.has(item.pageKey)
    );
    if (!source) continue;
    selected.set(candidate.slideIndex, source);
    usedDocumentIds.add(source.source.document_id);
    usedPages.add(source.pageKey);
  }
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
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

function fallbackVisual(slide: GeneratedSlide): GeneratedSlide {
  return {
    ...slide,
    visual: {
      mode: fallbackSlideVisualMode(slide),
      altText: slide.visual?.altText,
      caption: slide.visual?.caption,
    },
  };
}

/** 저장본의 과거 source-crop도 전체 페이지로 정규화하고, 처리 불가 요청은 즉시 폴백한다. */
export function planSourceVisualRequests(deck: GeneratedSlideDeck): SourceVisualRequestPlan {
  const requests: SourceVisualRequest[] = [];
  const rejected: RejectedVisualRequest[] = [];
  let requested = 0;

  const slides = deck.slides.map((slide, slideIndex) => {
    const visual = slide.visual;
    if (!visual || (visual.mode !== "source-page" && visual.mode !== "source-crop")) {
      return slide;
    }
    requested += 1;
    const normalizedSlide: GeneratedSlide = {
      ...slide,
      visual: { ...visual, mode: "source-page" },
    };
    const page = Number.isSafeInteger(visual.page) ? (visual.page as number) : 0;
    const validMetadata =
      slide.composition === "visual-explanation" &&
      Number.isSafeInteger(visual.documentId) &&
      (visual.documentId ?? 0) > 0 &&
      page > 0;

    if (!validMetadata || requests.length >= MAX_SOURCE_VISUALS_PER_DECK) {
      rejected.push({ slideIndex, page, title: slide.title });
      return fallbackVisual(normalizedSlide);
    }

    requests.push({
      slideIndex,
      documentId: visual.documentId as number,
      page,
      title: slide.title,
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

/**
 * 비공개 원본 PDF의 필요한 페이지만 브라우저에서 래스터 이미지로 만든다.
 * 서명 URL과 imageData는 저장하지 않고 PPTX 다운로드 직전 메모리에서만 사용한다.
 */
export async function prepareDeckSourceVisuals(
  deck: GeneratedSlideDeck,
  onProgress?: (progress: SourceVisualProgress) => void
): Promise<SourceVisualPreparation> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { deck, requested: 0, resolved: 0, failed: 0 };
  }

  const plan = planSourceVisualRequests(deck);
  if (plan.requested === 0) {
    return { deck: plan.deck, requested: 0, resolved: 0, failed: 0 };
  }

  let completed = 0;
  const failedSlideIndexes = new Set(plan.rejected.map((item) => item.slideIndex));
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
    };
  }

  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;

  const documentIds = Array.from(new Set(plan.requests.map((item) => item.documentId)));
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

  const imageBySlide = new Map<number, string>();

  for (const documentId of documentIds) {
    const source = signedSources.get(documentId);
    const documentRequests = plan.requests.filter((item) => item.documentId === documentId);
    if (!source || unavailableDocuments.has(documentId)) {
      for (const request of documentRequests) {
        failedSlideIndexes.add(request.slideIndex);
        completed += 1;
        onProgress?.({
          completed,
          total: plan.requested,
          title: request.title,
          page: request.page,
        });
      }
      continue;
    }

    let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
    try {
      pdf = await pdfjs.getDocument({ url: source.url }).promise;
      const renderedPages = new Map<number, string>();
      for (const request of documentRequests) {
        try {
          const pageNumber = exactPdfPageNumber(request.page, pdf.numPages);
          if (pageNumber === null) {
            throw new Error("요청한 원문 페이지가 실제 PDF 범위를 벗어났습니다.");
          }
          let imageData = renderedPages.get(pageNumber);
          if (!imageData) {
            const page = await pdf.getPage(pageNumber);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.max(
              1,
              Math.min(MAX_RENDER_WIDTH / base.width, MAX_RENDER_HEIGHT / base.height)
            );
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("PDF 페이지 렌더링 화면을 만들지 못했습니다.");
            await page.render({ canvasContext: context, viewport, background: "#FFFFFF" }).promise;
            imageData = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
            renderedPages.set(pageNumber, imageData);
            page.cleanup();
            canvas.width = 1;
            canvas.height = 1;
          }
          imageBySlide.set(request.slideIndex, imageData);
        } catch {
          failedSlideIndexes.add(request.slideIndex);
        } finally {
          completed += 1;
          onProgress?.({
            completed,
            total: plan.requested,
            title: request.title,
            page: request.page,
          });
        }
      }
    } catch {
      for (const request of documentRequests) {
        failedSlideIndexes.add(request.slideIndex);
        completed += 1;
        onProgress?.({
          completed,
          total: plan.requested,
          title: request.title,
          page: request.page,
        });
      }
    } finally {
      await pdf?.destroy();
    }
  }

  const preparedDeck: GeneratedSlideDeck = {
    ...plan.deck,
    slides: plan.deck.slides.map((slide, slideIndex) => {
      const imageData = imageBySlide.get(slideIndex);
      if (imageData && slide.visual) {
        return { ...slide, visual: { ...slide.visual, mode: "source-page", imageData } };
      }
      if (failedSlideIndexes.has(slideIndex)) return fallbackVisual(slide);
      return slide;
    }),
  };

  return {
    deck: preparedDeck,
    requested: plan.requested,
    resolved: imageBySlide.size,
    failed: Math.max(0, plan.requested - imageBySlide.size),
  };
}
