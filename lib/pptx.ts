// 생성 슬라이드(GeneratedSlideDeck) → PPTX 변환. 클라이언트에서 동적 import로만 사용.
// 디자인: 전북소방 표준 발표자료의 언어를 유지하면서, 교육 목적에 따라 레이아웃을 달리한다.
// AI는 내용·레이아웃 힌트·출처를 제공하고 이 모듈은 가독성, 여백, 발표자 노트를 책임진다.
import pptxgen from "pptxgenjs";
import {
  resolveSlideDeckMode,
  type GeneratedDocSource,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { sanitizeFilename } from "@/lib/utils";

const FONT = "Noto Sans KR"; // 업로드 서식과 동일 계열(공직 PC 기본 설치)
const INK = "1A2B4A"; // 본문 제목 잉크(딥 네이비)
const BODY = "2B3648"; // 본문 텍스트
const NAVY = "12233F"; // 표지·요약 배경
const GRAY = "6B7280"; // 보조
const HAIR = "E5E7EB"; // 헤어라인
const TINT = "F4F6F9"; // 연한 중립 배경
const COVER_SUB = "C8D2E0"; // 표지 부제(네이비 위)
const COVER_EYE = "9FB0CB"; // 표지 아이라벨
const COVER_FADE = "7C8AA6"; // 표지 안내문
const WHITE_HAIR = "31415E";

const SLIDE_WIDTH = 13.33;
const SLIDE_HEIGHT = 7.5;
const MARGIN_X = 0.72;
const CONTENT_WIDTH = SLIDE_WIDTH - MARGIN_X * 2;
const CONTENT_TOP = 1.66;
const CONTENT_BOTTOM = 6.78;

/** 발표 화면에서 실제 교육 내용을 읽을 수 있도록 보장하는 본문 최소 기준. */
export const MIN_BODY_FONT_SIZE = 16;
export const MAX_SLIDE_IMAGE_DATA_CHARS = 16_000_000;

export type RenderLayout =
  | "objectives"
  | "process"
  | "checklist"
  | "scenario"
  | "comparison"
  | "timeline"
  | "decision-flow"
  | "visual-explanation"
  | "summary"
  | "content";

type RichGeneratedSlide = GeneratedSlide & {
  layout?: unknown;
  sourceRefs?: string[];
};

const SAFE_SLIDE_IMAGE_DATA =
  /^data:image\/(?:png|jpe?g|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;

/** 원격 URL·SVG·임의 문자열은 PPTX에 직접 넣지 않고 검증된 래스터 data URL만 허용한다. */
export function isSafeSlideImageData(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SLIDE_IMAGE_DATA_CHARS &&
    SAFE_SLIDE_IMAGE_DATA.test(value)
  );
}

function hexOf(category: string): string {
  return categoryStyle(category).hex.replace("#", "");
}

function normalizedBullets(slide: GeneratedSlide): string[] {
  return slide.bullets
    .map((bullet) => bullet.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function normalizedSteps(slide: GeneratedSlide): string[] {
  return (slide.steps ?? [])
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function normalizedRefs(refs: string[]): string[] {
  return Array.from(
    new Set(refs.map((ref) => ref.trim().replace(/^[-•]\s*/, "")).filter(Boolean))
  );
}

export function formatDeckSources(sources: GeneratedDocSource[]): string[] {
  return normalizedRefs(
    sources.map((source) => `${source.doc}${source.page != null ? ` (p.${source.page})` : ""}`)
  );
}

/**
 * 슬라이드별 출처가 있으면 그것을, 없으면 덱 전체 출처를 노트에 남긴다.
 * 재생성된 노트에 이전 [Sources] 블록이 있더라도 하나만 유지한다.
 */
export function buildSpeakerNotes(
  notes: string | undefined,
  sourceRefs: string[] | undefined,
  deckSources: GeneratedDocSource[]
): string {
  const body = (notes ?? "").replace(/\n*\[Sources\][\s\S]*$/i, "").trim();
  const slideRefs = normalizedRefs(sourceRefs ?? []);
  const refs = slideRefs.length > 0 ? slideRefs : formatDeckSources(deckSources);
  const sourceLines = refs.length > 0 ? refs.map((ref) => `- ${ref}`) : ["- 연결된 근거 자료 없음"];

  return [body, `[Sources]\n${sourceLines.join("\n")}`].filter(Boolean).join("\n\n");
}

/** 명시적 레이아웃을 우선하고, 이전 저장본은 제목·steps로 적절한 구성을 추론한다. */
export function resolveSlideLayout(slide: GeneratedSlide & { layout?: unknown }): RenderLayout {
  const composition: unknown = slide.composition;
  if (
    composition === "process" ||
    composition === "comparison" ||
    composition === "timeline" ||
    composition === "decision-flow" ||
    composition === "visual-explanation" ||
    composition === "summary"
  ) {
    return composition;
  }
  if (composition === "checklist") return "checklist";
  if (composition === "scenario") return "scenario";
  if (composition === "statement" || composition === "list") return "content";

  const role: unknown = slide.role;
  if (role === "objectives") return "objectives";
  if (role === "procedure") return "process";
  if (role === "equipment" || role === "safety") return "checklist";
  if (role === "comparison") return "comparison";
  if (role === "timeline") return "timeline";
  if (role === "decision") return "decision-flow";
  if (role === "case") return "scenario";
  if (role === "evidence") return "visual-explanation";
  if (role === "summary") return "summary";

  const requested: unknown = slide.layout;
  if (
    requested === "objectives" ||
    requested === "process" ||
    requested === "summary"
  ) {
    return requested;
  }
  if (requested === "equipment" || requested === "safety" || requested === "checklist") {
    return "checklist";
  }
  if (requested === "case" || requested === "scenario") return "scenario";
  if (requested === "concept" || requested === "content") return "content";

  const title = slide.title.replace(/\s+/g, "");
  if (/(학습|교육|훈련)?목표/.test(title)) return "objectives";
  if ((slide.steps ?? []).filter(Boolean).length >= 2) return "process";
  if (/(점검|확인|체크|준비|장비|안전수칙)/.test(title)) return "checklist";
  if (/(사례|상황|시나리오|현장대응)/.test(title)) return "scenario";
  if (/(핵심요약|요약|정리|마무리)/.test(title)) return "summary";
  return "content";
}

export async function downloadPptx(
  deck: GeneratedSlideDeck,
  category: string,
  subtitle: string
): Promise<void> {
  const accent = hexOf(category);
  const deckMode = resolveSlideDeckMode(deck.mode);
  const deckModeLabel = deckMode === "detailed" ? "상세형 교육자료" : "발표형 교육자료";
  const bodyFont = (presenterSize: number): number =>
    Math.max(MIN_BODY_FONT_SIZE, presenterSize - (deckMode === "detailed" ? 2 : 0));
  const pres = new pptxgen();
  pres.defineLayout({ name: "WIDE", width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  pres.layout = "WIDE";
  pres.author = "전북특별자치도 소방본부";
  pres.subject = `${category} 분야 ${deckModeLabel}`;
  pres.title = deck.title;
  pres.company = "전북특별자치도 소방본부";

  const noLine = { type: "none" as const };
  type PptxSlide = ReturnType<typeof pres.addSlide>;

  function addFooter(slide: PptxSlide, page: number, total: number, dark = false): void {
    const lineColor = dark ? WHITE_HAIR : HAIR;
    const textColor = dark ? COVER_EYE : GRAY;
    slide.addShape("rect", {
      x: MARGIN_X,
      y: 6.96,
      w: CONTENT_WIDTH,
      h: 0.015,
      fill: { color: lineColor },
      line: noLine,
    });
    slide.addText("전북특별자치도 소방본부", {
      x: MARGIN_X,
      y: 7.04,
      w: 8,
      h: 0.24,
      fontFace: FONT,
      fontSize: 9,
      color: textColor,
      margin: 0,
    });
    slide.addText(`${page} / ${total}`, {
      x: 10.65,
      y: 7.04,
      w: 1.96,
      h: 0.24,
      fontFace: FONT,
      fontSize: 9,
      color: dark ? "FFFFFF" : accent,
      bold: true,
      align: "right",
      margin: 0,
    });
  }

  function addHeader(
    slide: PptxSlide,
    title: string,
    page: number,
    total: number,
    dark = false
  ): void {
    slide.addShape("roundRect", {
      x: MARGIN_X,
      y: 0.47,
      w: 0.64,
      h: 0.64,
      rectRadius: 0.1,
      fill: { color: accent },
      line: noLine,
    });
    slide.addText(String(page), {
      x: MARGIN_X,
      y: 0.47,
      w: 0.64,
      h: 0.64,
      fontFace: FONT,
      fontSize: 20,
      color: "FFFFFF",
      bold: true,
      align: "center",
      valign: "middle",
      margin: 0,
    });
    slide.addText(title, {
      x: 1.54,
      y: 0.41,
      w: 11.07,
      h: 0.78,
      fontFace: FONT,
      fontSize: 35,
      color: dark ? "FFFFFF" : INK,
      bold: true,
      valign: "middle",
      margin: 0,
      wrap: false,
      fit: "shrink",
    });
    slide.addShape("rect", {
      x: MARGIN_X,
      y: 1.36,
      w: CONTENT_WIDTH,
      h: 0.02,
      fill: { color: dark ? WHITE_HAIR : HAIR },
      line: noLine,
    });
    addFooter(slide, page, total, dark);
  }

  function addSectionLabel(slide: PptxSlide, label: string, dark = false): void {
    slide.addText(label, {
      x: 0.9,
      y: CONTENT_TOP,
      w: 4.5,
      h: 0.3,
      fontFace: FONT,
      fontSize: 16,
      color: dark ? COVER_EYE : accent,
      bold: true,
      charSpacing: 1.2,
      margin: 0,
    });
  }

  function renderObjectives(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    addSectionLabel(slide, "오늘 교육이 끝나면");
    const rowTop = 2.12;
    const rowHeight = Math.min(1.12, 4.4 / Math.max(bullets.length, 1));

    bullets.forEach((bullet, index) => {
      const y = rowTop + index * rowHeight;
      slide.addShape("ellipse", {
        x: 0.94,
        y: y + 0.08,
        w: 0.62,
        h: 0.62,
        fill: { color: index === 0 ? accent : "FFFFFF" },
        line: { color: accent, width: 1.5 },
      });
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: 0.94,
        y: y + 0.08,
        w: 0.62,
        h: 0.62,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: index === 0 ? "FFFFFF" : accent,
        bold: true,
        align: "center",
        valign: "middle",
        margin: 0,
      });
      slide.addText(bullet, {
        x: 1.82,
        y,
        w: 10.55,
        h: 0.8,
        fontFace: FONT,
        fontSize: bodyFont(23),
        color: BODY,
        bold: index === 0,
        valign: "middle",
        margin: 0.03,
        fit: "shrink",
      });
      if (index < bullets.length - 1) {
        slide.addShape("rect", {
          x: 1.82,
          y: y + rowHeight - 0.17,
          w: 10.55,
          h: 0.012,
          fill: { color: HAIR },
          line: noLine,
        });
      }
    });
  }

  function renderProcess(slide: PptxSlide, s: GeneratedSlide): void {
    const steps = normalizedSteps(s);
    if (steps.length < 2) {
      renderContent(slide, s);
      return;
    }

    addSectionLabel(slide, "현장 절차");
    const startX = 1.12;
    const endX = 12.21;
    const centerY = 2.63;
    const gap = (endX - startX) / (steps.length - 1);

    // 연결선을 먼저 그려 단계 노드와 라벨 뒤에 놓는다.
    for (let index = 0; index < steps.length - 1; index += 1) {
      const x1 = startX + index * gap + 0.5;
      const x2 = startX + (index + 1) * gap - 0.5;
      slide.addShape("line", {
        x: x1,
        y: centerY,
        w: Math.max(0.16, x2 - x1),
        h: 0,
        line: { color: accent, width: 1.8, endArrowType: "triangle", transparency: 25 },
      });
    }

    steps.forEach((step, index) => {
      const centerX = startX + index * gap;
      const isEdge = index === 0 || index === steps.length - 1;
      slide.addShape("ellipse", {
        x: centerX - 0.48,
        y: centerY - 0.48,
        w: 0.96,
        h: 0.96,
        fill: { color: isEdge ? accent : TINT },
        line: { color: accent, width: 1.6 },
      });
      slide.addText(String(index + 1), {
        x: centerX - 0.48,
        y: centerY - 0.48,
        w: 0.96,
        h: 0.96,
        fontFace: FONT,
        fontSize: 20,
        color: isEdge ? "FFFFFF" : accent,
        bold: true,
        align: "center",
        valign: "middle",
        margin: 0,
      });
      slide.addText(step, {
        x: centerX - Math.min(1.08, gap / 2),
        y: 3.25,
        w: Math.min(2.16, gap),
        h: 0.5,
        fontFace: FONT,
        fontSize: 17,
        color: INK,
        bold: true,
        align: "center",
        valign: "top",
        margin: 0,
        fit: "shrink",
      });
    });

    const bullets = normalizedBullets(s);
    slide.addText(
      bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { code: "25AA", indent: 20 }, breakLine: true, paraSpaceAfter: 7 },
      })),
      {
        x: 1.02,
        y: 4.15,
        w: 11.25,
        h: 2.25,
        fontFace: FONT,
        fontSize: bodyFont(bullets.length >= 4 ? 17 : 19),
        color: BODY,
        lineSpacingMultiple: 1.2,
        valign: "top",
        margin: 0.04,
        breakLine: false,
        fit: "shrink",
      }
    );
  }

  function renderChecklist(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    addSectionLabel(slide, "현장 확인 체크");
    const rowTop = 2.12;
    const rowHeight = Math.min(1.12, 4.38 / Math.max(bullets.length, 1));

    bullets.forEach((bullet, index) => {
      const y = rowTop + index * rowHeight;
      slide.addShape("ellipse", {
        x: 0.94,
        y: y + 0.05,
        w: 0.56,
        h: 0.56,
        fill: { color: accent, transparency: index === 0 ? 0 : 86 },
        line: { color: accent, width: 1.5 },
      });
      slide.addText("✓", {
        x: 0.94,
        y: y + 0.05,
        w: 0.56,
        h: 0.56,
        fontFace: FONT,
        fontSize: 16,
        color: index === 0 ? "FFFFFF" : accent,
        bold: true,
        align: "center",
        valign: "middle",
        margin: 0,
      });
      slide.addText(bullet, {
        x: 1.78,
        y,
        w: 10.5,
        h: 0.72,
        fontFace: FONT,
        fontSize: bodyFont(22),
        color: BODY,
        bold: index === 0,
        valign: "middle",
        margin: 0.03,
        fit: "shrink",
      });
      if (index < bullets.length - 1) {
        slide.addShape("rect", {
          x: 1.78,
          y: y + rowHeight - 0.19,
          w: 10.5,
          h: 0.012,
          fill: { color: HAIR },
          line: noLine,
        });
      }
    });
  }

  function renderScenario(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    if (bullets.length < 2) {
      renderContent(slide, s);
      return;
    }

    addSectionLabel(slide, "상황을 읽고 대응합니다");
    slide.addShape("rect", {
      x: 0.9,
      y: 2.12,
      w: 4.35,
      h: 4.22,
      fill: { color: TINT },
      line: noLine,
    });
    slide.addShape("rect", {
      x: 0.9,
      y: 2.12,
      w: 0.08,
      h: 4.22,
      fill: { color: accent },
      line: noLine,
    });
    slide.addText("상황", {
      x: 1.22,
      y: 2.47,
      w: 3.65,
      h: 0.35,
      fontFace: FONT,
      fontSize: 17,
      color: accent,
      bold: true,
      charSpacing: 1.2,
      margin: 0,
    });
    slide.addText(bullets[0], {
      x: 1.22,
      y: 3.0,
      w: 3.55,
      h: 2.65,
      fontFace: FONT,
      fontSize: bodyFont(25),
      color: INK,
      bold: true,
      valign: "middle",
      margin: 0,
      fit: "shrink",
      breakLine: false,
    });

    slide.addText("대응 포인트", {
      x: 5.85,
      y: 2.12,
      w: 3.2,
      h: 0.4,
      fontFace: FONT,
      fontSize: 20,
      color: accent,
      bold: true,
      margin: 0,
    });
    bullets.slice(1).forEach((bullet, index) => {
      const y = 2.82 + index * 1.15;
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: 5.85,
        y,
        w: 0.55,
        h: 0.38,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        margin: 0,
      });
      slide.addText(bullet, {
        x: 6.55,
        y: y - 0.06,
        w: 5.73,
        h: 0.72,
        fontFace: FONT,
        fontSize: bodyFont(20),
        color: BODY,
        bold: index === 0,
        margin: 0,
        fit: "shrink",
      });
      if (index < bullets.length - 2) {
        slide.addShape("rect", {
          x: 5.85,
          y: y + 0.78,
          w: 6.43,
          h: 0.012,
          fill: { color: HAIR },
          line: noLine,
        });
      }
    });
  }

  function renderComparison(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    const labels = normalizedSteps(s);
    if (bullets.length < 2) {
      renderContent(slide, s);
      return;
    }

    addSectionLabel(slide, "두 기준을 나란히 비교합니다");
    const splitAt = Math.ceil(bullets.length / 2);
    const columns = [bullets.slice(0, splitAt), bullets.slice(splitAt)];
    const headings = [labels[0] || "비교 기준 1", labels[1] || "비교 기준 2"];

    columns.forEach((items, columnIndex) => {
      const x = columnIndex === 0 ? 0.92 : 6.88;
      slide.addShape("roundRect", {
        x,
        y: 2.12,
        w: 5.52,
        h: 4.17,
        rectRadius: 0.08,
        fill: { color: columnIndex === 0 ? TINT : "FFFFFF" },
        line: { color: columnIndex === 0 ? HAIR : accent, width: columnIndex === 0 ? 1 : 1.4 },
      });
      slide.addShape("rect", {
        x,
        y: 2.12,
        w: 5.52,
        h: 0.08,
        fill: { color: accent, transparency: columnIndex === 0 ? 46 : 0 },
        line: noLine,
      });
      slide.addText(headings[columnIndex], {
        x: x + 0.36,
        y: 2.48,
        w: 4.8,
        h: 0.52,
        fontFace: FONT,
        fontSize: 21,
        color: columnIndex === 0 ? INK : accent,
        bold: true,
        margin: 0,
        fit: "shrink",
      });
      items.forEach((item, itemIndex) => {
        const y = 3.28 + itemIndex * 1.25;
        slide.addText(String(itemIndex + 1).padStart(2, "0"), {
          x: x + 0.36,
          y,
          w: 0.5,
          h: 0.34,
          fontFace: FONT,
          fontSize: MIN_BODY_FONT_SIZE,
          color: accent,
          bold: true,
          margin: 0,
        });
        slide.addText(item, {
          x: x + 1.0,
          y: y - 0.06,
          w: 4.15,
          h: 0.82,
          fontFace: FONT,
          fontSize: bodyFont(20),
          color: BODY,
          bold: itemIndex === 0,
          margin: 0,
          fit: "shrink",
        });
      });
    });
  }

  function renderTimeline(slide: PptxSlide, s: GeneratedSlide): void {
    const steps = normalizedSteps(s);
    if (steps.length < 3) {
      renderProcess(slide, s);
      return;
    }

    addSectionLabel(slide, "시간 흐름에 따라 확인합니다");
    const startX = 1.15;
    const endX = 12.18;
    const centerY = 3.35;
    const gap = (endX - startX) / (steps.length - 1);
    slide.addShape("line", {
      x: startX,
      y: centerY,
      w: endX - startX,
      h: 0,
      line: { color: accent, width: 2.2, transparency: 20 },
    });

    steps.forEach((step, index) => {
      const centerX = startX + index * gap;
      const labelAbove = index % 2 === 0;
      slide.addShape("ellipse", {
        x: centerX - 0.25,
        y: centerY - 0.25,
        w: 0.5,
        h: 0.5,
        fill: { color: index === 0 || index === steps.length - 1 ? accent : "FFFFFF" },
        line: { color: accent, width: 1.8 },
      });
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: centerX - 0.45,
        y: labelAbove ? 2.08 : 3.93,
        w: 0.9,
        h: 0.3,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        align: "center",
        margin: 0,
      });
      slide.addText(step, {
        x: centerX - Math.min(1.05, gap / 2),
        y: labelAbove ? 2.43 : 4.27,
        w: Math.min(2.1, gap),
        h: 0.62,
        fontFace: FONT,
        fontSize: bodyFont(18),
        color: INK,
        bold: true,
        align: "center",
        valign: "middle",
        margin: 0,
        fit: "shrink",
      });
    });

    const bullets = normalizedBullets(s).slice(0, 2);
    if (bullets.length > 0) {
      slide.addText(bullets.join("  ·  "), {
        x: 1.05,
        y: 5.34,
        w: 11.22,
        h: 0.72,
        fontFace: FONT,
        fontSize: bodyFont(18),
        color: BODY,
        align: "center",
        margin: 0.03,
        fit: "shrink",
      });
    }
  }

  function renderDecisionFlow(slide: PptxSlide, s: GeneratedSlide): void {
    const steps = normalizedSteps(s);
    const bullets = normalizedBullets(s);
    if (steps.length < 3 || bullets.length < 2) {
      renderScenario(slide, s);
      return;
    }

    addSectionLabel(slide, "조건에 따라 다음 행동을 결정합니다");
    slide.addShape("diamond", {
      x: 5.53,
      y: 2.1,
      w: 2.28,
      h: 1.36,
      fill: { color: TINT },
      line: { color: accent, width: 1.8 },
    });
    slide.addText(steps[0], {
      x: 5.78,
      y: 2.48,
      w: 1.78,
      h: 0.55,
      fontFace: FONT,
      fontSize: bodyFont(18),
      color: INK,
      bold: true,
      align: "center",
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });

    const branches = [
      { x: 1.15, label: steps[1], text: bullets[1] ?? bullets[0] },
      { x: 7.15, label: steps[2], text: bullets[2] ?? bullets[bullets.length - 1] },
    ];
    branches.forEach((branch, index) => {
      slide.addShape("line", {
        x: index === 0 ? 3.85 : 7.68,
        y: 3.42,
        w: 1.8,
        h: 0.72,
        line: {
          color: accent,
          width: 1.8,
          ...(index === 0
            ? { beginArrowType: "triangle" as const }
            : { endArrowType: "triangle" as const }),
          transparency: 22,
        },
      });
      slide.addShape("roundRect", {
        x: branch.x,
        y: 4.25,
        w: 5.03,
        h: 1.45,
        rectRadius: 0.08,
        fill: { color: index === 0 ? "FFFFFF" : TINT },
        line: { color: accent, width: index === 0 ? 1.4 : 1 },
      });
      slide.addText(branch.label, {
        x: branch.x + 0.3,
        y: 4.5,
        w: 1.38,
        h: 0.42,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        margin: 0,
        fit: "shrink",
      });
      slide.addText(branch.text, {
        x: branch.x + 1.75,
        y: 4.39,
        w: 2.95,
        h: 0.82,
        fontFace: FONT,
        fontSize: bodyFont(19),
        color: BODY,
        bold: true,
        margin: 0,
        fit: "shrink",
      });
    });

    const question = bullets[0];
    slide.addText(question, {
      x: 1.22,
      y: 5.92,
      w: 10.89,
      h: 0.45,
      fontFace: FONT,
      fontSize: bodyFont(17),
      color: GRAY,
      align: "center",
      margin: 0,
      fit: "shrink",
    });
  }

  function renderVisualExplanation(slide: PptxSlide, s: GeneratedSlide): void {
    const visual = s.visual;
    const bullets = normalizedBullets(s);
    const imageData = visual?.imageData;
    const hasImage = isSafeSlideImageData(imageData);
    const imageX = 0.92;
    const imageY = 2.05;
    const imageW = 7.05;
    const imageH = 3.95;
    addSectionLabel(slide, "원문 시각자료와 함께 확인합니다");

    slide.addShape("roundRect", {
      x: imageX,
      y: imageY,
      w: imageW,
      h: imageH,
      rectRadius: 0.06,
      fill: { color: hasImage ? "FFFFFF" : TINT },
      line: {
        color: hasImage ? HAIR : accent,
        width: hasImage ? 1 : 1.2,
        dashType: hasImage ? "solid" : "dash",
      },
    });
    if (hasImage) {
      slide.addImage({
        data: imageData,
        x: imageX + 0.08,
        y: imageY + 0.08,
        w: imageW - 0.16,
        h: imageH - 0.16,
        sizing: {
          type: visual?.fit === "cover" ? "cover" : "contain",
          w: imageW - 0.16,
          h: imageH - 0.16,
        },
        altText: visual?.altText?.trim() || "근거 문서의 원문 시각자료",
        objectName: "근거 원문 시각자료",
      });
    } else {
      slide.addText("원문 시각자료 연결 대기", {
        x: imageX + 0.55,
        y: imageY + 1.1,
        w: imageW - 1.1,
        h: 0.55,
        fontFace: FONT,
        fontSize: 23,
        color: INK,
        bold: true,
        align: "center",
        margin: 0,
      });
      slide.addText(
        visual?.altText?.trim() ||
          "검증된 원문 페이지가 연결되지 않아 설명 텍스트로 대신합니다.",
        {
          x: imageX + 0.72,
          y: imageY + 1.86,
          w: imageW - 1.44,
          h: 1.1,
          fontFace: FONT,
          fontSize: bodyFont(18),
          color: GRAY,
          align: "center",
          valign: "middle",
          margin: 0,
          fit: "shrink",
        }
      );
    }

    const sourceRef = visual?.sourceRef?.trim() || normalizedRefs(s.sourceRefs ?? [])[0];
    const caption = [visual?.caption?.trim(), sourceRef].filter(Boolean).join(" · ");
    slide.addText(caption || "출처 정보는 발표자 노트에서 확인", {
      x: imageX,
      y: 6.13,
      w: imageW,
      h: 0.35,
      fontFace: FONT,
      fontSize: MIN_BODY_FONT_SIZE,
      color: GRAY,
      margin: 0,
      fit: "shrink",
    });

    slide.addText("설명 포인트", {
      x: 8.43,
      y: 2.05,
      w: 3.65,
      h: 0.4,
      fontFace: FONT,
      fontSize: 19,
      color: accent,
      bold: true,
      margin: 0,
    });
    bullets.forEach((bullet, index) => {
      const y = 2.78 + index * 0.96;
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: 8.43,
        y,
        w: 0.48,
        h: 0.34,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        margin: 0,
      });
      slide.addText(bullet, {
        x: 9.04,
        y: y - 0.05,
        w: 3.27,
        h: 0.67,
        fontFace: FONT,
        fontSize: bodyFont(18),
        color: BODY,
        bold: index === 0,
        margin: 0,
        fit: "shrink",
      });
    });
  }

  function renderSummary(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    addSectionLabel(slide, "교육 핵심 정리", true);

    bullets.forEach((bullet, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = col === 0 ? 0.94 : 6.86;
      const y = 2.18 + row * 2.0;
      slide.addText(String(index + 1).padStart(2, "0"), {
        x,
        y,
        w: 0.62,
        h: 0.4,
        fontFace: FONT,
        fontSize: 16,
        color: accent,
        bold: true,
        margin: 0,
      });
      slide.addShape("rect", {
        x,
        y: y + 0.55,
        w: 0.68,
        h: 0.045,
        fill: { color: accent },
        line: noLine,
      });
      slide.addText(bullet, {
        x: x + 0.92,
        y: y - 0.04,
        w: 4.85,
        h: 1.2,
        fontFace: FONT,
        fontSize: bodyFont(22),
        color: "FFFFFF",
        bold: index === 0,
        valign: "top",
        margin: 0,
        fit: "shrink",
      });
    });
  }

  function renderContent(slide: PptxSlide, s: GeneratedSlide): void {
    const bullets = normalizedBullets(s);
    addSectionLabel(slide, "핵심 메시지");

    if (bullets.length <= 1) {
      slide.addShape("rect", {
        x: 1.02,
        y: 2.3,
        w: 0.09,
        h: 3.35,
        fill: { color: accent },
        line: noLine,
      });
      slide.addText(bullets[0] ?? "내용을 확인해 주세요.", {
        x: 1.48,
        y: 2.38,
        w: 10.35,
        h: 3.05,
        fontFace: FONT,
        fontSize: bodyFont(30),
        color: INK,
        bold: true,
        valign: "middle",
        margin: 0,
        fit: "shrink",
      });
      return;
    }

    slide.addShape("rect", {
      x: 0.94,
      y: 2.18,
      w: 0.08,
      h: 3.95,
      fill: { color: accent },
      line: noLine,
    });
    slide.addText(bullets[0], {
      x: 1.32,
      y: 2.22,
      w: 4.2,
      h: 3.65,
      fontFace: FONT,
      fontSize: bodyFont(26),
      color: INK,
      bold: true,
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
    slide.addText("설명 포인트", {
      x: 6.05,
      y: 2.18,
      w: 3.2,
      h: 0.4,
      fontFace: FONT,
      fontSize: 20,
      color: accent,
      bold: true,
      margin: 0,
    });
    bullets.slice(1).forEach((bullet, index) => {
      const y = 2.91 + index * 1.03;
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: 6.05,
        y,
        w: 0.52,
        h: 0.36,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        margin: 0,
      });
      slide.addText(bullet, {
        x: 6.72,
        y: y - 0.06,
        w: 5.5,
        h: 0.72,
        fontFace: FONT,
        fontSize: bodyFont(20),
        color: BODY,
        bold: index === 0,
        margin: 0,
        fit: "shrink",
      });
      if (index < bullets.length - 2) {
        slide.addShape("rect", {
          x: 6.05,
          y: y + 0.73,
          w: 6.17,
          h: 0.012,
          fill: { color: HAIR },
          line: noLine,
        });
      }
    });
  }

  // ───────── 표지 ─────────
  const cover = pres.addSlide();
  cover.background = { color: NAVY };
  cover.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.22,
    h: SLIDE_HEIGHT,
    fill: { color: accent },
    line: noLine,
  });
  cover.addText(`전북특별자치도 소방본부  ·  ${category} 분야  ·  ${deckModeLabel}`, {
    x: 0.92,
    y: 2.12,
    w: 11.45,
    h: 0.42,
    fontFace: FONT,
    fontSize: 16,
    color: COVER_EYE,
    bold: true,
    charSpacing: 2,
    margin: 0,
  });
  cover.addText(deck.title, {
    x: 0.9,
    y: 2.72,
    w: 11.55,
    h: 1.82,
    fontFace: FONT,
    fontSize: 52,
    color: "FFFFFF",
    bold: true,
    valign: "top",
    lineSpacingMultiple: 1.02,
    margin: 0,
    fit: "shrink",
  });
  cover.addShape("rect", {
    x: 0.92,
    y: 4.77,
    w: 1.75,
    h: 0.07,
    fill: { color: accent },
    line: noLine,
  });
  cover.addText(subtitle, {
    x: 0.92,
    y: 5.04,
    w: 11.45,
    h: 0.52,
    fontFace: FONT,
    fontSize: 18,
    color: COVER_SUB,
    margin: 0,
    fit: "shrink",
  });
  cover.addText("AI 생성 초안 — 시행 전 담당자 검토가 필요합니다.", {
    x: 0.92,
    y: 6.75,
    w: 11.45,
    h: 0.3,
    fontFace: FONT,
    fontSize: 11,
    color: COVER_FADE,
    margin: 0,
  });
  cover.addNotes(
    buildSpeakerNotes(
      "발표 제목과 교육 대상·시간을 확인한 뒤 교육을 시작합니다.",
      undefined,
      deck.sources
    )
  );

  const total = deck.slides.length;

  // ───────── 본문 ─────────
  deck.slides.forEach((rawSlide, index) => {
    const s = rawSlide as RichGeneratedSlide;
    const layout = resolveSlideLayout(s);
    const slide = pres.addSlide();
    const dark = layout === "summary";
    slide.background = { color: dark ? NAVY : "FFFFFF" };
    addHeader(slide, s.title, index + 1, total, dark);

    if (layout === "objectives") renderObjectives(slide, s);
    else if (layout === "process") renderProcess(slide, s);
    else if (layout === "checklist") renderChecklist(slide, s);
    else if (layout === "scenario") renderScenario(slide, s);
    else if (layout === "comparison") renderComparison(slide, s);
    else if (layout === "timeline") renderTimeline(slide, s);
    else if (layout === "decision-flow") renderDecisionFlow(slide, s);
    else if (layout === "visual-explanation") renderVisualExplanation(slide, s);
    else if (layout === "summary") renderSummary(slide, s);
    else renderContent(slide, s);

    slide.addNotes(
      buildSpeakerNotes(
        s.notes,
        normalizedRefs([...(s.sourceRefs ?? []), ...(s.visual?.sourceRef ? [s.visual.sourceRef] : [])]),
        deck.sources
      )
    );
  });

  // ───────── 근거 자료 ─────────
  const sourceChunks: GeneratedDocSource[][] = [];
  for (let index = 0; index < deck.sources.length; index += 7) {
    sourceChunks.push(deck.sources.slice(index, index + 7));
  }

  sourceChunks.forEach((sources, chunkIndex) => {
    const last = pres.addSlide();
    last.background = { color: "FFFFFF" };
    const title = sourceChunks.length > 1 ? `근거 자료 ${chunkIndex + 1}` : "근거 자료";
    last.addText(title, {
      x: MARGIN_X,
      y: 0.45,
      w: 11.89,
      h: 0.76,
      fontFace: FONT,
      fontSize: 35,
      color: INK,
      bold: true,
      valign: "middle",
      margin: 0,
      wrap: false,
      fit: "shrink",
    });
    last.addShape("rect", {
      x: MARGIN_X,
      y: 1.36,
      w: CONTENT_WIDTH,
      h: 0.02,
      fill: { color: HAIR },
      line: noLine,
    });

    sources.forEach((source, index) => {
      const y = 1.72 + index * 0.72;
      last.addText(String(chunkIndex * 7 + index + 1).padStart(2, "0"), {
        x: 0.82,
        y,
        w: 0.58,
        h: 0.35,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: accent,
        bold: true,
        margin: 0,
      });
      last.addText(source.doc, {
        x: 1.54,
        y: y - 0.05,
        w: 9.08,
        h: 0.48,
        fontFace: FONT,
        fontSize: 18,
        color: BODY,
        bold: index === 0,
        margin: 0,
        wrap: false,
        fit: "shrink",
      });
      last.addText(source.page != null ? `p.${source.page}` : "페이지 정보 없음", {
        x: 10.82,
        y: y - 0.03,
        w: 1.66,
        h: 0.35,
        fontFace: FONT,
        fontSize: MIN_BODY_FONT_SIZE,
        color: GRAY,
        align: "right",
        margin: 0,
      });
      if (index < sources.length - 1) {
        last.addShape("rect", {
          x: 1.54,
          y: y + 0.52,
          w: 10.94,
          h: 0.012,
          fill: { color: HAIR },
          line: noLine,
        });
      }
    });

    last.addText("각 슬라이드 발표자 노트의 [Sources] 블록에서도 근거를 확인할 수 있습니다.", {
      x: MARGIN_X,
      y: CONTENT_BOTTOM - 0.15,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontFace: FONT,
      fontSize: 11,
      color: GRAY,
      margin: 0,
    });
    last.addNotes(buildSpeakerNotes("발표에 사용한 근거 자료를 확인합니다.", undefined, sources));
  });

  await pres.writeFile({ fileName: `${sanitizeFilename(deck.title)}.pptx` });
}
