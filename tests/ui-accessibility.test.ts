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
  resolvePreviewLayout,
  SlideDeckResult,
} from "@/components/generate/SlideDeckResult";
import { DocResult } from "@/components/generate/DocResult";
import { MobileMoreSheet } from "@/components/layout/MobileMoreSheet";
import { TopicFocusPanel } from "@/components/generate/TopicFocusPanel";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import type { GeneratedDoc, GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";

const sampleSlide: GeneratedSlide = {
  title: "화학보호복 착용 전 점검",
  bullets: ["보호복과 호흡보호구의 손상 여부를 확인합니다."],
  notes: "교관 설명",
  layout: "summary",
  composition: "statement",
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
  sources: [],
};

function renderSlideDeck({
  editing = true,
  pptxLoading = false,
  saving = false,
  outputBlocked = false,
} = {}) {
  return renderToStaticMarkup(
    createElement(SlideDeckResult, {
      deck: sampleDeck,
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
      quality: outputBlocked
        ? {
            checked: true,
            repaired: true,
            errors: ["교육 시간 합계", "안전·중단 기준"],
            warnings: ["일부 슬라이드 제목 길이"],
          }
        : undefined,
    })
  );
}

const sampleDoc: GeneratedDoc = {
  title: "화학보호복 훈련계획",
  sections: [{ heading: "훈련내용", content: "보호복 착용 절차를 반복 숙달합니다." }],
  sources: [],
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

  it("composition을 우선해 미리보기를 정하고 필요한 항목과 안전한 시각자료를 보정한다", () => {
    expect(resolvePreviewLayout(sampleSlide)).toBe("concept");

    const comparison = normalizedCompositionPatch(sampleSlide, "comparison");
    expect(comparison.bullets).toHaveLength(2);
    expect(comparison.steps).toHaveLength(2);
    expect(comparison.visual).toEqual({ mode: "native-diagram" });

    const decision = normalizedCompositionPatch(sampleSlide, "decision-flow");
    expect(decision.bullets).toHaveLength(2);
    expect(decision.steps).toHaveLength(3);
  });
});

describe("문서 편집 상태 잠금", () => {
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
        ],
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
    expect(html).toContain("최근 세부 방향과 겹침 적음");
    expect(html).toContain("SOP·표준절차의 적용 여부와 근거 상태");
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
