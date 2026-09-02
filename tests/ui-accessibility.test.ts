import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CategoryCitationsChart,
  DailyQuestionsChart,
} from "@/components/admin/StatsChart";
import { DocsBrowser, type DocRow } from "@/components/docs/DocsBrowser";
import {
  normalizedCompositionPatch,
  normalizedSourceRefsPatch,
  resolvePreviewLayout,
  slideVisualSummary,
  SlideDeckResult,
  verifiedDeckSourceLabels,
  verifiedSlideVisualCandidates,
} from "@/components/generate/SlideDeckResult";
import { DocResult } from "@/components/generate/DocResult";
import {
  blockingDeckQualityIssues,
  blockingSlideQualityIssueGroups,
  ResultSkeleton,
  type EvidenceRepairState,
  type GenerationQuality,
  type QualityRepairState,
} from "@/components/generate/parts";
import { MobileMoreSheet } from "@/components/layout/MobileMoreSheet";
import { TopicFocusPanel } from "@/components/generate/TopicFocusPanel";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import type {
  GeneratedDoc,
  GeneratedSlide,
  GeneratedSlideDeck,
  GenerationQualityIssue,
} from "@/lib/generate";
import type { PublicGenerationJob } from "@/lib/generation-job";

const sampleSlide: GeneratedSlide = {
  title: "화학보호복 착용 전 점검",
  bullets: ["보호복과 호흡보호구의 손상 여부를 확인합니다."],
  notes: "교관 설명",
  layout: "summary",
  composition: "statement",
  sourceRefs: ["[교육자료 1 p.1]"],
  visual: {
    mode: "source-page",
    assetId: "source-asset",
    documentId: 12,
    page: 3,
    imageData: "data:image/png;base64,AAAA",
  },
};

const sampleDeck: GeneratedSlideDeck = {
  title: "화학보호복 교육",
  mode: "presenter",
  slides: [sampleSlide],
  sources: Array.from({ length: 8 }, (_, index) => ({
    document_id: index + 1,
    doc: `교육자료 ${index + 1}`,
    page: index + 1,
  })),
  sourceLabels: Array.from({ length: 8 }, (_, index) =>
    `[교육자료 ${index + 1} p.${index + 1}]`
  ),
};

function renderSlideDeck({
  editing = true,
  pptxLoading = false,
  saving = false,
  outputBlocked = false,
  evidenceRepair = undefined as EvidenceRepairState | undefined,
  qualityRepair = undefined as QualityRepairState | undefined,
  quality = undefined as GenerationQuality | undefined,
  deck = sampleDeck as GeneratedSlideDeck,
} = {}) {
  return renderToStaticMarkup(
    createElement(SlideDeckResult, {
      deck,
      chrome: {
        accent: "#b91c1c",
        editing,
        onToggleEdit: () => undefined,
        saving,
        outputBlocked,
        saved: false,
        loadedId: null,
        onSave: () => undefined,
      },
      regen: {
        openIndex: null,
        loadingIndex: null,
        text: "",
        onTextChange: () => undefined,
        onOpen: () => undefined,
        onClose: () => undefined,
        onApply: () => undefined,
      },
      onTitleChange: () => undefined,
      onPatchSlide: () => undefined,
      onPatchBullet: () => undefined,
      onAddSlide: () => undefined,
      onDuplicateSlide: () => undefined,
      onMoveSlide: () => undefined,
      onDeleteSlide: () => undefined,
      onDownloadPptx: () => undefined,
      pptxLoading,
      evidenceRepair,
      onRepairEvidence: () => undefined,
      qualityRepair,
      onRepairQuality: () => undefined,
      quality: quality ?? (outputBlocked
        ? {
            checked: true,
            repaired: true,
            errors: ["교육 시간 합계", "안전·중단 기준"],
            warnings: ["일부 슬라이드 제목 길이"],
          }
        : undefined),
    })
  );
}

const sampleDoc: GeneratedDoc = {
  title: "화학보호복 훈련계획",
  sections: [{ heading: "훈련내용", content: "보호복 착용 절차를 반복 숙달합니다." }],
  sources: [{ document_id: 1, doc: "화학보호복 교육자료", page: 12 }],
};

function renderDoc({
  saving = false,
  regenLoading = false,
  exporting = null as "hwpx" | "docx" | null,
  outputBlocked = false,
} = {}) {
  return renderToStaticMarkup(
    createElement(DocResult, {
      doc: sampleDoc,
      chrome: {
        accent: "#b91c1c",
        editing: true,
        onToggleEdit: () => undefined,
        saving,
        outputBlocked,
        saved: false,
        loadedId: null,
        onSave: () => undefined,
      },
      regen: {
        openIndex: null,
        loadingIndex: regenLoading ? 0 : null,
        text: "",
        onTextChange: () => undefined,
        onOpen: () => undefined,
        onClose: () => undefined,
        onApply: () => undefined,
      },
      copied: false,
      onTitleChange: () => undefined,
      onPatchSection: () => undefined,
      onDownloadHwpx: () => undefined,
      onDownloadDocx: () => undefined,
      onCopy: () => undefined,
      exporting,
      quality: outputBlocked
        ? {
            checked: true,
            repaired: false,
            errors: ["필수 구성 누락"],
            warnings: [],
          }
        : undefined,
    })
  );
}

describe("공통 UI 접근성", () => {
  it("카드 제목은 기본 h2이고 페이지 제목으로 재정의할 수 있다", () => {
    const sectionTitle = renderToStaticMarkup(
      createElement(CardTitle, null, "통계")
    );
    const pageTitle = renderToStaticMarkup(
      createElement(
        CardTitle,
        { asChild: true },
        createElement("h1", null, "비밀번호 변경")
      )
    );

    expect(sectionTitle).toContain("<h2");
    expect(pageTitle).toContain("<h1");
  });

  it("공통 버튼은 화면 폭과 관계없이 최소 터치 영역을 유지한다", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { size: "icon", "aria-label": "열기" }, "+")
    );

    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
    expect(html).not.toContain("md:min-h-0");
    expect(html).not.toContain("md:min-w-0");
  });

  it("정밀 생성 대기 중 경과시간·예상 완료·예상 단계를 함께 안내한다", () => {
    const html = renderToStaticMarkup(
      createElement(ResultSkeleton, {
        accent: "#b91c1c",
        label: "슬라이드(PPTX)",
        type: "slides",
        duration: "4시간",
      })
    );

    expect(html).toContain("경과 시간");
    expect(html).toContain("00:00");
    expect(html).toContain("1차 결과 예상 완료");
    expect(html).toContain("통상 예상 20분 내외");
    expect(html).toContain("예상 단계");
    expect(html).toContain('aria-live="polite"');
  });

  it("영속 생성 작업은 실제 서버 단계·진행률과 화면 종료 후 계속 진행됨을 안내한다", () => {
    const job: PublicGenerationJob = {
      id: "019cbe63-acde-7000-8000-000000000001",
      status: "reviewing",
      stage: "교안 구성과 안전 기준 점검",
      progress: 72,
      attempt: 1,
      estimatedSeconds: 540,
      qualityPassed: false,
      request: {
        type: "lesson",
        category: "화재",
        audience: "신임 대원",
        duration: "1시간",
        topic: "공기호흡기 점검",
      },
      result: null,
      errorMessage: null,
      workflowRunId: "run-1",
      revision: 3,
      createdAt: "2026-09-02T01:00:00.000Z",
      startedAt: "2026-09-02T01:00:01.000Z",
      updatedAt: "2026-09-02T01:04:00.000Z",
      completedAt: null,
    };

    const html = renderToStaticMarkup(
      createElement(ResultSkeleton, {
        accent: "#b91c1c",
        label: "교안",
        type: "lesson",
        duration: "1시간",
        job,
        connectionRetry: { attempt: 2, retryAt: Date.now() + 5_000 },
      })
    );

    expect(html).toContain("현재 단계");
    expect(html).toContain("교안 구성과 안전 기준 점검");
    expect(html).toContain("72%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("서버 접수가 완료되어 화면을 닫아도 계속 진행됩니다");
    expect(html).toContain("서버 상태 연결을 다시 시도합니다");
  });

  it("품질 미통과 영속 작업은 저장 지점 재시도만 제공한다", () => {
    const failedJob: PublicGenerationJob = {
      id: "019cbe63-acde-7000-8000-000000000002",
      status: "needs_attention",
      stage: "품질 기준 확인 필요",
      progress: 88,
      attempt: 2,
      estimatedSeconds: 720,
      qualityPassed: false,
      request: {
        type: "slides",
        category: "화재",
        audience: "일반 대원",
        duration: "2시간",
        topic: "고립소방관 구조 절차",
      },
      result: null,
      errorMessage: "일부 슬라이드의 근거를 다시 확인해야 합니다.",
      workflowRunId: "run-2",
      revision: 5,
      createdAt: "2026-09-02T01:00:00.000Z",
      startedAt: "2026-09-02T01:00:01.000Z",
      updatedAt: "2026-09-02T01:10:00.000Z",
      completedAt: "2026-09-02T01:10:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(ResultSkeleton, {
        accent: "#b91c1c",
        label: "슬라이드(PPTX)",
        type: "slides",
        duration: "2시간",
        job: failedJob,
        onRetry: () => undefined,
      })
    );

    expect(html).toContain("추가 품질 점검이 필요합니다");
    expect(html).toContain("일부 슬라이드의 근거를 다시 확인해야 합니다.");
    expect(html).toContain("저장된 작업 다시 시도");
    expect(html).not.toContain("서버 접수가 완료되어 화면을 닫아도 계속 진행됩니다");
  });
});

describe("자료실 필터", () => {
  it("기본 분야와 문서에서 발견한 추가 분야를 모두 제공한다", () => {
    const documents: DocRow[] = [
      {
        id: 1,
        title: "화학보호복 점검",
        category: "화학사고",
        equipment: ["화학보호복"],
        difficulty: "중급",
        file_url: null,
        publish_date: "2026-08-28",
        source_type: "pdf",
      },
    ];

    const html = renderToStaticMarkup(
      createElement(DocsBrowser, { documents })
    );

    expect(html).toContain("일반구조");
    expect(html).toContain("화학사고");
    expect(html).toContain('for="document-search"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="tab"');
  });
});

describe("통계 차트 대체 정보", () => {
  it("차트의 정확한 값을 펼쳐 볼 수 있는 표로 함께 제공한다", () => {
    const daily = renderToStaticMarkup(
      createElement(DailyQuestionsChart, {
        data: [{ date: "2026-08-28", count: 3 }],
      })
    );
    const category = renderToStaticMarkup(
      createElement(CategoryCitationsChart, {
        data: [{ category: "화재", count: 7 }],
      })
    );

    expect(daily).toContain("일별 수치를 표로 보기");
    expect(daily).toContain("3건");
    expect(daily).toContain('aria-hidden="true"');
    expect(daily.match(/최근 1일 동안 질문 3건, 가장 많은 날은 2026-08-28 3건입니다\./g)).toHaveLength(1);
    expect(category).toContain("분야별 수치를 표로 보기");
    expect(category).toContain("7회");
  });
});

describe("슬라이드 편집 접근성과 상태", () => {
  it("본문 장수와 표지·근거 부록을 포함한 실제 다운로드 장수를 구분한다", () => {
    const html = renderSlideDeck({ editing: false });

    expect(html).toContain("본문 1장 · 다운로드 총 4장(표지·근거 포함)");
    expect(html).toContain("PPTX 다운로드 · 총 4장 (발표자 노트 포함)");
  });

  it("썸네일 버튼은 간결한 이름을 갖고 장문 미리보기는 접근성 트리에서 숨긴다", () => {
    const html = renderSlideDeck();

    expect(html).toContain('aria-label="슬라이드 1: 화학보호복 착용 전 점검"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("PPTX 준비 중에는 다운로드를 잠그고 진행 상태를 알린다", () => {
    const html = renderSlideDeck({ editing: false, pptxLoading: true });

    expect(html).toContain("PPTX 준비 중…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("PPTX 파일을 준비하고 있습니다.");
  });

  it("저장 중에는 제목과 편집 영역 전체를 잠근다", () => {
    const html = renderSlideDeck({ saving: true });

    expect(html).toContain("자료를 저장하고 있습니다.");
    expect(html).toContain("<fieldset disabled=\"\" aria-busy=\"true\"");
    expect(html).toContain('disabled="" aria-label="발표 제목"');
  });

  it("PPTX 준비 중에도 편집 영역 전체를 잠근다", () => {
    const html = renderSlideDeck({ pptxLoading: true });

    expect(html).toContain("PPTX 파일을 준비하고 있습니다.");
    expect(html).toContain('<fieldset disabled="" aria-busy="true"');
    expect(html).toContain('disabled="" aria-label="발표 제목"');
  });

  it("핵심 품질 오류는 경고과 구분해 알리고 PPTX 내보내기만 잠근다", () => {
    const html = renderSlideDeck({ outputBlocked: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("핵심 품질 오류가 있어 저장·내보내기가 잠겼습니다");
    expect(html).toContain("차단하지 않는 추가 검토 항목: 일부 슬라이드 제목 길이");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<[^>]+>)*PPTX 다운로드/);
    expect(html).toContain("편집하거나 해당 부분을 AI로 다시 생성해 주세요.");
  });

  it("차단 오류의 slides.N 경로를 정확한 장·제목·원인·문제 부분으로 안내한다", () => {
    const blockingIssue: GenerationQualityIssue = {
      code: "thin_content",
      path: "slides.0.notes",
      message: "발표자 노트에 시범 절차와 확인 질문을 더 작성해 주세요.",
      excerpt: "교관 설명",
    };
    const warningIssue: GenerationQualityIssue = {
      code: "thin_notes",
      path: "slides.0.notes",
      message: "이 경고는 차단 오류 상세 목록에 표시하지 않습니다.",
    };
    const groups = blockingSlideQualityIssueGroups(
      [warningIssue, blockingIssue, { ...blockingIssue, path: "slides.9.notes" }],
      sampleDeck.slides.map((slide) => slide.title)
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].index).toBe(0);
    expect(groups[0].issues).toEqual([blockingIssue]);

    const html = renderSlideDeck({
      outputBlocked: true,
      qualityRepair: { status: "idle", issueIndices: [0] },
      quality: {
        checked: true,
        repaired: true,
        errors: ["일부 내용의 구체성·분량"],
        warnings: [],
        issues: [blockingIssue, warningIssue],
      },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("‘화학보호복 교육’에서 먼저 고칠 슬라이드");
    expect(html).toContain("슬라이드 1");
    expect(html).toContain("화학보호복 착용 전 점검");
    expect(html).toContain(blockingIssue.message);
    expect(html).toContain("문제 부분: “교관 설명”");
    expect(html).not.toContain(warningIssue.message);
    expect(html).toContain(
      'aria-label="슬라이드 1 화학보호복 착용 전 점검 편집으로 이동"'
    );
    expect(html).toContain("min-h-11 shrink-0 bg-background");
    expect(html).toContain("dark:border-red-900");
    expect(html).toContain("문제 슬라이드 AI로 보완");
    expect(html).toContain('id="selected-slide-heading" tabindex="-1"');
  });

  it("전체 품질 보완과 근거 전용 보완을 서로 다른 동작으로 함께 제공한다", () => {
    const html = renderSlideDeck({
      outputBlocked: true,
      evidenceRepair: { status: "idle", issueIndices: [0] },
      qualityRepair: {
        status: "failed",
        issueIndices: [0],
        message: "SOP 적용 내용을 자동 보완하지 못했습니다.",
      },
    });

    expect(html).toContain("문제 슬라이드 AI로 보완");
    expect(html).toContain("누락 근거 다시 보완");
    expect(html).toContain("SOP 적용 내용을 자동 보완하지 못했습니다.");
    expect(html).toContain('aria-label="근거 확인이 필요한 슬라이드 1 편집"');
  });

  it("자동으로 고를 안전한 SOP 장이 없으면 이유를 표시하고 무의미한 보완 버튼은 숨긴다", () => {
    const message =
      "자동 보완할 SOP 적용 장을 고를 수 없습니다. 위 입력 영역의 ‘슬라이드(PPTX) 만들기’를 다시 눌러 전체 초안을 생성해 주세요.";
    const deckIssue: GenerationQualityIssue = {
      code: "missing_sop_application",
      path: "slides",
      message: "지정 위치에 [관련 SOP 적용] 표식을 포함해야 합니다.",
    };
    const html = renderSlideDeck({
      outputBlocked: true,
      qualityRepair: { status: "failed", issueIndices: [], message },
      quality: {
        checked: true,
        repaired: false,
        errors: ["SOP·표준절차 적용 내용"],
        warnings: [],
        issues: [deckIssue],
      },
    });

    expect(blockingDeckQualityIssues([deckIssue])).toEqual([deckIssue]);
    expect(html).toContain(message);
    expect(html).toContain("전체 구성에서 먼저 고칠 항목");
    expect(html).toContain(deckIssue.message);
    expect(html).not.toContain("문제 슬라이드 AI로 보완");
    expect(html).toContain('role="alert"');
  });

  it("문제 슬라이드 보완 중에는 진행 상태를 알리고 중복 동작을 잠근다", () => {
    const html = renderSlideDeck({
      editing: false,
      outputBlocked: true,
      qualityRepair: { status: "repairing", issueIndices: [0] },
    });

    expect(html).toContain("문제 슬라이드 보완 중");
    expect(html).toContain("슬라이드 1의 내용과 구성을 다시 점검하고 있습니다");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("문제 슬라이드 보완 중…");
    expect(html).toContain("경과 시간");
    expect(html).toContain("예상 완료");
  });

  it("슬라이드 근거 확인 중에는 대상 장 번호를 알리고 저장·PPTX를 잠근다", () => {
    const html = renderSlideDeck({
      editing: false,
      outputBlocked: true,
      evidenceRepair: { status: "repairing", issueIndices: [0] },
    });

    expect(html).toContain("근거 확인 중");
    expect(html).toContain("슬라이드 1의 출처를 교육자료와 대조하고 있습니다");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-describedby="generation-quality-summary"');
    expect(html).not.toContain('title="핵심 품질 오류를 수정한 뒤 내보낼 수 있습니다."');
  });

  it("미해결 근거 오류는 정확한 장 이동과 44px 이상 재시도 동작을 제공한다", () => {
    const html = renderSlideDeck({
      outputBlocked: true,
      evidenceRepair: {
        status: "failed",
        issueIndices: [0],
        message: "자동 보완하지 못했습니다.",
      },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-label="근거 확인이 필요한 슬라이드 1 편집"');
    expect(html).toContain("누락 근거 다시 보완");
    expect(html).toContain("min-h-11 min-w-11");
    expect(html).toContain('id="selected-slide-heading" tabindex="-1"');
    expect(html).toContain("focus:ring-2 focus:ring-ring");
  });

  it("편집 화면에서는 서버가 검증한 출처만 체크박스로 1~4개 선택한다", () => {
    const html = renderSlideDeck();

    expect(html).toContain("근거 출처 (1~4개)");
    expect(html).toContain("자유 입력은 지원하지 않습니다.");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("[교육자료 1 p.1]");
    expect(html).toContain("선택 1/4");
    expect(html).toContain("근거는 최소 1개를 유지해야 합니다");
    expect(html).not.toContain('placeholder="출처');
    expect(verifiedDeckSourceLabels(["임의 표기", "[교육자료 p.1]", "[줄바꿈\n p.2]"])).toEqual([
      "[교육자료 p.1]",
    ]);
  });

  it("근거를 4개 선택하면 나머지 검증 출처는 비활성화하고 교체 방법을 안내한다", () => {
    const sourceRefs = sampleDeck.sourceLabels?.slice(0, 4) ?? [];
    const html = renderSlideDeck({
      deck: {
        ...sampleDeck,
        slides: [{ ...sampleSlide, sourceRefs }],
      },
    });

    expect(html).toContain("선택 4/4");
    expect(html).toContain("최대 4개를 선택했습니다");
    expect(html).toMatch(/id="slide-source-0-4"[^>]*disabled=""/);
  });

  it("composition을 우선해 미리보기를 정하고 필요한 항목과 안전한 시각자료를 보정한다", () => {
    expect(resolvePreviewLayout(sampleSlide)).toBe("concept");

    const comparison = normalizedCompositionPatch(sampleSlide, "comparison");
    expect(comparison.bullets).toHaveLength(2);
    expect(comparison.steps).toHaveLength(2);
    expect(comparison.visual).toEqual({ mode: "native-diagram" });

    const decision = normalizedCompositionPatch(sampleSlide, "decision-flow");
    expect(decision.bullets).toHaveLength(2);
    expect(decision.steps).toHaveLength(3);

    const candidates = verifiedSlideVisualCandidates(sampleSlide, sampleDeck.sources);
    expect(candidates).toEqual([
      {
        label: "[교육자료 1 p.1]",
        documentId: 1,
        page: 1,
        documentTitle: "교육자료 1",
      },
    ]);
    const sourceVisual = normalizedCompositionPatch(
      sampleSlide,
      "visual-explanation",
      candidates[0]
    );
    expect(sourceVisual.visual).toMatchObject({
      mode: "source-page",
      documentId: 1,
      page: 1,
      sourceRef: "[교육자료 1 p.1]",
      fit: "contain",
    });
    expect(normalizedCompositionPatch(sampleSlide, "visual-explanation")).toEqual({});
  });

  it("현재 원문 근거를 해제하면 남은 검증 페이지로 화면·저장 메타데이터를 함께 바꾼다", () => {
    const sources = [
      { document_id: 1, doc: "교육자료 1", page: 1 },
      { document_id: 2, doc: "교육자료 2", page: 2 },
    ];
    const slide: GeneratedSlide = {
      ...sampleSlide,
      composition: "visual-explanation",
      sourceRefs: ["[교육자료 1 p.1]", "[교육자료 2 p.2]"],
      visual: {
        mode: "source-page",
        documentId: 1,
        page: 1,
        sourceRef: "[교육자료 1 p.1]",
      },
    };

    const patch = normalizedSourceRefsPatch(slide, ["[교육자료 2 p.2]"], sources);

    expect(patch.sourceRefs).toEqual(["[교육자료 2 p.2]"]);
    expect(patch.visual).toMatchObject({
      mode: "source-page",
      documentId: 2,
      page: 2,
      sourceRef: "[교육자료 2 p.2]",
    });
  });

  it("원문 후보가 사라지면 불완전한 자리표시자 대신 내용 중심 구도로 안전하게 내린다", () => {
    const patch = normalizedSourceRefsPatch(
      {
        ...sampleSlide,
        composition: "visual-explanation",
        visual: {
          mode: "source-page",
          documentId: 1,
          page: 1,
          sourceRef: "[교육자료 1 p.1]",
        },
      },
      ["[페이지 없는 자료]"],
      [{ document_id: 9, doc: "페이지 없는 자료", page: null }]
    );

    expect(patch.composition).toBe("list");
    expect(patch.visual).toEqual({ mode: "none" });
  });

  it("한글 조합 방식이 다른 출처도 같은 원문 후보로 표시한다", () => {
    const nfdTitle = "교육자료".normalize("NFD");
    const nfcLabel = `[${nfdTitle.normalize("NFC")} p.1]`;

    expect(
      verifiedSlideVisualCandidates(
        { ...sampleSlide, sourceRefs: [nfcLabel] },
        [{ document_id: 7, doc: nfdTitle, page: 1 }]
      )
    ).toMatchObject([{ documentId: 7, page: 1 }]);
    expect(
      verifiedDeckSourceLabels([`[${nfdTitle} p.1]`, nfcLabel])
    ).toHaveLength(1);
  });

  it("자동 시각 구성 요약과 원문 선택 가능 여부를 명확히 표시한다", () => {
    const html = renderSlideDeck({
      deck: {
        ...sampleDeck,
        slides: [
          {
            ...sampleSlide,
            composition: "visual-explanation",
            visual: {
              mode: "source-page",
              documentId: 1,
              page: 1,
              sourceRef: "[교육자료 1 p.1]",
              altText: "교육자료 1 원문",
            },
          },
        ],
      },
    });

    expect(html).toContain("현재 구성 · 원문 1장 · 편집 가능한 도형 0장 · 내용 중심 0장");
    expect(html).toContain("슬라이드 표현 방식");
    expect(html).toContain("원문 페이지");
    expect(slideVisualSummary(sampleDeck.slides)).toEqual({
      source: 1,
      diagram: 0,
      content: 0,
    });
  });
});

describe("문서 편집 상태 잠금", () => {
  it("본문 뒤에 근거 자료와 페이지를 한 번만 모아 표시한다", () => {
    const html = renderDoc();

    expect(html).toContain("근거 자료 및 출처");
    expect(html).toContain("화학보호복 교육자료 p.12");
    expect(html.indexOf("근거 자료 및 출처")).toBeGreaterThan(
      html.indexOf("보호복 착용 절차를 반복 숙달합니다.")
    );
    expect(html).not.toContain("근거:");
  });

  it("저장 중에는 제목·본문 편집과 내보내기를 잠그고 상태를 알린다", () => {
    const html = renderDoc({ saving: true });

    expect(html).toContain("자료를 저장하고 있습니다.");
    expect(html).toContain('<fieldset disabled="" aria-busy="true"');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="문서 제목"/);
    expect(html).toContain("한글(hwpx) 다운로드");
  });

  it("부분 재생성 중에도 편집 영역과 내보내기를 잠근다", () => {
    const html = renderDoc({ regenLoading: true });

    expect(html).toContain("섹션 1을 다시 생성하고 있습니다.");
    expect(html).toContain('<fieldset disabled="" aria-busy="true"');
  });

  it("문서 파일 준비 중에도 편집 영역을 잠그고 진행 상태를 보여 준다", () => {
    const html = renderDoc({ exporting: "hwpx" });

    expect(html).toContain("한글 파일을 준비하고 있습니다.");
    expect(html).toContain("한글 파일 준비 중…");
    expect(html).toContain('<fieldset disabled="" aria-busy="true"');
  });

  it("핵심 품질 오류가 있으면 편집 안내를 유지하면서 문서 내보내기를 잠근다", () => {
    const html = renderDoc({ outputBlocked: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("먼저 수정할 항목: 필수 구성 누락");
    expect(html).toContain("핵심 품질 오류를 수정한 뒤 내보낼 수 있습니다.");
  });
});

describe("넓은 훈련 주제 세부 방향", () => {
  it("네이티브 라디오·단일 상태 영역·48px 동작 버튼으로 선택 흐름을 제공한다", () => {
    const html = renderToStaticMarkup(
      createElement(TopicFocusPanel, {
        topic: "산악사고대비 훈련",
        status: "choosing",
        options: [
          {
            id: "focus-1",
            title: "조난자 수색구역 설정",
            description: "수색 구역과 위치정보 공유를 실습합니다.",
            sourceRefs: ["[산악 교범 p.12]"],
          },
          {
            id: "focus-2",
            title: "급경사 로프 접근과 확보",
            description: "급경사 접근 전 확보 지점과 역할을 확인합니다.",
            sourceRefs: ["[로프구조 교범 p.8]"],
          },
        ],
        similarMaterials: [
          {
            id: 37,
            kind: "plan",
            title: "산악사고 대비 훈련계획",
            topic: "산악사고대비 훈련",
            focus: "조난자 수색구역 설정",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        recommendedId: "focus-1",
        selectedId: "focus-1",
        customValue: "",
        historyCompared: true,
        warnings: [],
        headingRef: createRef<HTMLHeadingElement>(),
        onSelect: () => undefined,
        onCustomValueChange: () => undefined,
        onRefresh: () => undefined,
        onBypass: () => undefined,
      })
    );

    expect(html).toContain('type="radio"');
    expect(html).toContain('name="topic-focus"');
    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-12");
    expect(html).toContain("선택됨");
    expect(html).toContain("이 계정 저장 자료와 겹침 적음");
    expect(html).toContain("SOP·표준절차의 적용 여부와 근거 상태");
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("이 계정의 최근 유사 자료");
    expect(html).toContain("1건 표시");
    expect(html).toContain("최대 5건 표시합니다");
    expect(html).toContain("훈련계획");
    expect(html).toContain("열어 편집");
    expect(html).toContain('href="/generate?m=37"');
    expect(html).toContain("작성자는 공유 로그인 환경에서 구분되지 않습니다");
    expect(html.match(/\(추천\)/g)).toHaveLength(1);
    expect(html).toMatch(/조난자 수색구역 설정[\s\S]*?\(추천\)[\s\S]*?급경사 로프 접근과 확보/);
  });

  it("API가 추천 순위를 확인하지 않은 선택지에는 추천 표시를 임의로 붙이지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(TopicFocusPanel, {
        topic: "암모니아 누출 대응훈련",
        status: "choosing",
        options: [
          {
            id: "focus-1",
            title: "고정 데모 훈련 방향",
            description: "입력 주제와의 추천 순위를 확인하지 않은 예시입니다.",
            sourceRefs: ["[데모 연결 교범 p.1]"],
          },
        ],
        similarMaterials: [],
        customValue: "",
        historyCompared: false,
        warnings: [],
        headingRef: createRef<HTMLHeadingElement>(),
        onSelect: () => undefined,
        onCustomValueChange: () => undefined,
        onRefresh: () => undefined,
        onBypass: () => undefined,
      })
    );

    expect(html).not.toContain("(추천)");
    expect(html).not.toContain("이 계정의 최근 유사 자료");
  });
});

describe("모바일 더보기 새 공지", () => {
  it("더보기 트리거 이름과 시각 표시로 새 공지를 알린다", () => {
    const html = renderToStaticMarkup(
      createElement(MobileMoreSheet, { hasNewNotice: true })
    );

    expect(html).toContain('aria-label="더보기 메뉴, 새 공지 있음"');
    expect(html).toContain("bg-ops-signal-soft");
  });
});
