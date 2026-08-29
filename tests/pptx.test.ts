import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type {
  GeneratedDocSource,
  GeneratedSlide,
  GeneratedSlideDeck,
  SlideLayoutType,
} from "@/lib/generate";
import {
  buildSpeakerNotes,
  downloadPptx,
  formatDeckSources,
  isSafeSlideImageData,
  MIN_BODY_FONT_SIZE,
  resolveSlideLayout,
} from "@/lib/pptx";

function slide(
  title: string,
  options: Partial<GeneratedSlide> = {}
): GeneratedSlide {
  return {
    title,
    bullets: ["핵심 내용을 확인한다"],
    notes: "교관 설명",
    ...options,
  };
}

const deckSources: GeneratedDocSource[] = [
  { document_id: 1, doc: "구조대원 교육교범", page: 3 },
  { document_id: 2, doc: "현장 안전관리 지침", page: null },
];

describe("resolveSlideLayout", () => {
  it("생성 스키마의 의미 레이아웃을 실제 렌더 구도로 매핑한다", () => {
    expect(resolveSlideLayout(slide("학습 목표", { layout: "objectives" }))).toBe(
      "objectives"
    );
    expect(resolveSlideLayout(slide("핵심 개념", { layout: "concept" }))).toBe("content");
    expect(resolveSlideLayout(slide("진입 절차", { layout: "process" }))).toBe("process");
    expect(resolveSlideLayout(slide("장비 점검", { layout: "equipment" }))).toBe(
      "checklist"
    );
    expect(resolveSlideLayout(slide("현장 사례", { layout: "case" }))).toBe("scenario");
    expect(resolveSlideLayout(slide("안전 수칙", { layout: "safety" }))).toBe("checklist");
    expect(resolveSlideLayout(slide("핵심 요약", { layout: "summary" }))).toBe("summary");
  });

  it("과거 저장본은 제목과 단계 정보를 이용해 레이아웃을 추론한다", () => {
    expect(resolveSlideLayout(slide("교육 목표"))).toBe("objectives");
    expect(resolveSlideLayout(slide("현장 진입", { steps: ["확인", "진입", "보고"] }))).toBe(
      "process"
    );
    expect(resolveSlideLayout(slide("장비 사전 점검"))).toBe("checklist");
    expect(resolveSlideLayout(slide("현장 대응 사례"))).toBe("scenario");
    expect(resolveSlideLayout(slide("오늘의 핵심 요약"))).toBe("summary");
    expect(resolveSlideLayout(slide("공기호흡기 기본 원리"))).toBe("content");
  });

  it("교육 역할과 화면 구도를 분리하고 화면 구도를 우선한다", () => {
    expect(
      resolveSlideLayout(
        slide("정상과 이상을 비교합니다", {
          role: "safety",
          composition: "comparison",
        })
      )
    ).toBe("comparison");
    expect(resolveSlideLayout(slide("시간 순서", { role: "timeline" }))).toBe("timeline");
    expect(resolveSlideLayout(slide("조건 판단", { composition: "decision-flow" }))).toBe(
      "decision-flow"
    );
    expect(
      resolveSlideLayout(slide("교범 그림", { composition: "visual-explanation" }))
    ).toBe("visual-explanation");
  });
});

describe("PPTX 시각자료 입력 안전성", () => {
  it("검증된 래스터 data URL만 허용하고 URL·SVG·과대 데이터는 거부한다", () => {
    expect(isSafeSlideImageData("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeSlideImageData("https://example.com/image.png")).toBe(false);
    expect(isSafeSlideImageData("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeSlideImageData(`data:image/png;base64,${"A".repeat(16_000_001)}`)).toBe(
      false
    );
  });
});

describe("PPTX 발표자 노트 출처", () => {
  it("슬라이드 출처가 있으면 덱 전체 출처 대신 해당 출처만 기록한다", () => {
    const notes = buildSpeakerNotes("현장 사례를 설명합니다.", ["[교범 p.7]"], deckSources);

    expect(notes).toContain("현장 사례를 설명합니다.");
    expect(notes).toContain("[Sources]\n- [교범 p.7]");
    expect(notes).not.toContain("구조대원 교육교범");
  });

  it("슬라이드 출처가 없으면 덱 출처를 페이지와 함께 사용한다", () => {
    const notes = buildSpeakerNotes("점검 절차를 시범합니다.", undefined, deckSources);

    expect(notes).toContain("- 구조대원 교육교범 (p.3)");
    expect(notes).toContain("- 현장 안전관리 지침");
  });

  it("기존 Sources 블록을 중복하지 않고 최신 출처로 교체한다", () => {
    const notes = buildSpeakerNotes(
      "설명 대본\n\n[Sources]\n- 이전 출처",
      ["- 새 출처", "새 출처"],
      deckSources
    );

    expect(notes.match(/\[Sources\]/g)).toHaveLength(1);
    expect(notes).toContain("- 새 출처");
    expect(notes).not.toContain("이전 출처");
  });

  it("덱 출처 표기는 중복을 제거한다", () => {
    expect(formatDeckSources([...deckSources, deckSources[0]])).toEqual([
      "구조대원 교육교범 (p.3)",
      "현장 안전관리 지침",
    ]);
  });
});

describe("PPTX 실제 파일 생성", () => {
  it("모든 의미 레이아웃과 슬라이드별 Sources 노트를 포함한 PPTX를 만든다", async () => {
    expect(MIN_BODY_FONT_SIZE).toBeGreaterThanOrEqual(16);
    const requestedOutput = process.env.PPTX_QA_OUTPUT_DIR;
    const workDir = requestedOutput ?? mkdtempSync(join(tmpdir(), "rescueai-pptx-test-"));
    if (requestedOutput) mkdirSync(workDir, { recursive: true });
    const previousCwd = process.cwd();
    const layouts: SlideLayoutType[] = [
      "objectives",
      "concept",
      "process",
      "equipment",
      "case",
      "safety",
      "summary",
    ];
    const sourceImageData =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const enhancedSlides: GeneratedSlide[] = [
      slide("정상 상태와 이상 상태를 나란히 구분합니다", {
        role: "comparison",
        composition: "comparison",
        steps: ["정상 상태", "이상 상태"],
        bullets: [
          "정상 표시는 교범의 점검 위치와 기준에 따라 확인합니다",
          "확인 결과를 동료에게 말해 다음 점검 전 누락을 막습니다",
          "이상 표시는 즉시 사용을 멈추고 안전담당자에게 보고합니다",
          "원인이 해소되기 전에는 장비를 다시 사용하지 않습니다",
        ],
      }),
      slide("훈련은 준비부터 결과 보고까지 시간 순서로 이어집니다", {
        role: "timeline",
        composition: "timeline",
        steps: ["사전 준비", "교관 시범", "대원 실습", "결과 보고"],
      }),
      slide("조건 확인 후 진행 또는 중단을 결정합니다", {
        role: "decision",
        composition: "decision-flow",
        steps: ["상태 확인", "훈련 진행", "즉시 중단"],
        bullets: [
          "장비와 대원의 상태가 안전 기준에 맞는지 먼저 확인합니다",
          "정상 상태를 확인한 경우에만 다음 단계로 진행합니다",
          "이상 상태가 보이면 즉시 중단하고 안전담당자에게 보고합니다",
        ],
      }),
      slide("교범 원문 그림에서 확인 위치를 찾습니다", {
        role: "evidence",
        composition: "visual-explanation",
        bullets: [
          "원문 그림에서 장비의 점검 위치를 먼저 찾습니다",
          "그림의 설명과 현장 장비 상태를 차례로 비교합니다",
        ],
        visual: {
          mode: "source-page",
          documentId: 1,
          page: 12,
          sourceRef: "[구조대원 교육교범 p.12]",
          altText: "구조대원 교육교범의 장비 점검 위치 그림",
          caption: "교범 원문 장비 점검 위치",
          fit: "contain",
          imageData: sourceImageData,
        },
      }),
    ];
    const deck: GeneratedSlideDeck = {
      title: "PPTX 다중 레이아웃 현장 교육 검증",
      mode: "detailed",
      slides: [
        ...layouts.map((layout, index) => ({
          title:
            layout === "process"
              ? "현장 절차는 확인부터 보고까지 이어집니다"
              : `${index + 1}번째 핵심 행동을 현장에서 확인합니다`,
          bullets: [
            "교관 시범을 본 뒤 대원이 같은 순서로 직접 수행합니다",
            "이상 상태를 발견하면 즉시 중단하고 안전담당자에게 보고합니다",
            "체크리스트로 누락 없이 수행했는지 서로 확인합니다",
          ],
          steps:
            layout === "process"
              ? ["위험 확인", "장비 점검", "대원 수행", "결과 보고"]
              : undefined,
          notes:
            "교관은 먼저 이 행동이 필요한 이유를 설명합니다. 정상 상태와 이상 상태를 직접 비교해 보여 줍니다. 대원에게 다음 행동을 질문하여 이해 여부를 확인합니다. 실습에서는 한 번에 한 가지 행동만 피드백합니다. 이상이 발견되면 즉시 중단하고 안전담당자에게 보고하도록 강조합니다.",
          layout,
          sourceRefs: ["[구조대원 교육교범 p.12]"],
        })),
        ...enhancedSlides,
      ],
      sources: deckSources,
    };

    try {
      process.chdir(workDir);
      await downloadPptx(deck, "화재", "대상: 일반 대원 · 교육 시간: 1시간");
      const files = readdirSync(workDir).filter((name) => name.endsWith(".pptx"));
      expect(files).toHaveLength(1);

      const zip = await JSZip.loadAsync(readFileSync(join(workDir, files[0])));
      const notePaths = Object.keys(zip.files).filter((name) =>
        /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)
      );
      expect(notePaths.length).toBeGreaterThanOrEqual(deck.slides.length);
      const notesXml = (
        await Promise.all(notePaths.map((name) => zip.files[name].async("string")))
      ).join("\n");
      expect(notesXml).toContain("[Sources]");
      expect(notesXml).toContain("[구조대원 교육교범 p.12]");

      const slideXml = (
        await Promise.all(
          Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .map((name) => zip.files[name].async("string"))
        )
      ).join("\n");
      // 번호·출처 같은 본문 보조 요소도 13~14pt 대신 16pt 기준을 사용한다.
      expect(slideXml).not.toContain('sz="1300"');
      expect(slideXml).not.toContain('sz="1400"');
      expect(slideXml).toContain("상세형 교육자료");
      expect(slideXml).toContain("구조대원 교육교범의 장비 점검 위치 그림");
      const mediaPaths = Object.keys(zip.files).filter((name) =>
        /^ppt\/media\/image[-\d]+\./.test(name)
      );
      expect(mediaPaths.length).toBeGreaterThanOrEqual(1);
    } finally {
      process.chdir(previousCwd);
      if (!requestedOutput) rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});
