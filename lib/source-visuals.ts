import {
  fallbackSlideVisualMode,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";

const PDF_WORKER_PATH = "/pdf.worker.min.mjs";
const MAX_SOURCE_VISUALS_PER_DECK = 8;
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
