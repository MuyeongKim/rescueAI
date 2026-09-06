// 생성 슬라이드(GeneratedSlideDeck) → PPTX 변환. 클라이언트에서 동적 import로만 사용.
// 디자인: 전북소방 표준 발표자료의 언어를 유지하면서, 교육 목적에 따라 레이아웃을 달리한다.
// AI는 내용·레이아웃 힌트·출처를 제공하고 이 모듈은 가독성, 여백, 발표자 노트를 책임진다.
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import {
  resolveSlideDeckMode,
  type GeneratedDocSource,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { PPTX_SOURCES_PER_APPENDIX_SLIDE } from "@/lib/pptx-plan";
import { buildSlideLayoutPlan, SLIDE_TITLE_BOX as BODY_TITLE_BOX, slideTitleFontSize as headerTitleFontSize, slideAccentTextColor, type RenderLayout, type SlideColor } from "@/lib/slide-layout";
export { resolveSlideLayout } from "@/lib/slide-layout";
export type { RenderLayout } from "@/lib/slide-layout";
import { sanitizeFilename } from "@/lib/utils";

const FONT = "Noto Sans KR"; // 미설치 환경은 PPT 프로그램의 대체 글꼴을 사용한다.
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

async function normalizePptxPackage(rawBytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(rawBytes);
  const contentTypesPart = zip.file("[Content_Types].xml");
  if (!contentTypesPart) {
    throw new Error("PPTX Content Types 파트를 찾을 수 없습니다.");
  }

  const existingParts = new Set(Object.keys(zip.files).map((path) => `/${path}`));
  const contentTypesXml = await contentTypesPart.async("string");
  const normalizedContentTypes = contentTypesXml.replace(
    /<Override\b(?=[^>]*\bPartName="(\/ppt\/slideMasters\/slideMaster\d+\.xml)")(?=[^>]*\bContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slideMaster\+xml")[^>]*\/>/g,
    (override, partName: string) => (existingParts.has(partName) ? override : "")
  );
  zip.file("[Content_Types].xml", normalizedContentTypes);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function buildPptxBytes(
  deck: GeneratedSlideDeck,
  category: string,
  subtitle: string
): Promise<Uint8Array> {
  const accent = hexOf(category);
  const deckMode = resolveSlideDeckMode(deck.mode);
  const deckModeLabel = deckMode === "detailed" ? "상세형 교육자료" : "발표형 교육자료";
  const pres = new pptxgen();
  pres.defineLayout({ name: "WIDE", width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  pres.layout = "WIDE";
  pres.author = "전북특별자치도 소방본부";
  pres.subject = `${category} 분야 ${deckModeLabel}`;
  pres.title = deck.title;
  pres.company = "전북특별자치도 소방본부";

  const noLine = { type: "none" as const };
  type PptxSlide = ReturnType<typeof pres.addSlide>;
  type MasterObjects = NonNullable<
    Parameters<typeof pres.defineSlideMaster>[0]["objects"]
  >;

  const MASTER = {
    cover: "JBFD_COVER",
    objectives: "JBFD_OBJECTIVES",
    process: "JBFD_PROCESS",
    checklist: "JBFD_CHECKLIST",
    checklistFeatured: "JBFD_CHECKLIST_FEATURED",
    scenario: "JBFD_SCENARIO",
    comparison: "JBFD_COMPARISON",
    timeline: "JBFD_TIMELINE",
    decision: "JBFD_DECISION",
    visual: "JBFD_VISUAL_EVIDENCE",
    summary: "JBFD_SUMMARY",
    content: "JBFD_CONTENT",
    contentMirror: "JBFD_CONTENT_MIRROR",
    sources: "JBFD_SOURCES",
  } as const;
  function footerMasterObjects(dark = false): MasterObjects {
    return [
      {
        rect: {
          x: MARGIN_X,
          y: 6.96,
          w: CONTENT_WIDTH,
          h: 0.015,
          fill: { color: dark ? WHITE_HAIR : HAIR },
          line: noLine,
        },
      },
      {
        text: {
          text: "전북특별자치도 소방본부",
          options: {
            x: MARGIN_X,
            y: 7.04,
            w: 8,
            h: 0.24,
            fontFace: FONT,
            fontSize: 9,
            color: dark ? COVER_EYE : GRAY,
            margin: 0,
          },
        },
      },
    ];
  }

  function bodyMasterObjects(
    sectionLabel: string,
    options: { dark?: boolean; mirror?: boolean } = {}
  ): MasterObjects {
    const dark = options.dark ?? false;
    const objects: MasterObjects = [
      {
        placeholder: {
          options: {
            name: "slideTitle",
            type: "title",
            ...BODY_TITLE_BOX,
            fontFace: FONT,
            fontSize: 35,
            color: dark ? "FFFFFF" : INK,
            bold: true,
            align: "left",
            valign: "middle",
            margin: 0,
          },
          text: "",
        },
      },
      {
        rect: {
          x: MARGIN_X,
          y: 1.36,
          w: CONTENT_WIDTH,
          h: 0.02,
          fill: { color: dark ? WHITE_HAIR : HAIR },
          line: noLine,
        },
      },
    ];

    if (sectionLabel) {
      objects.push({
        text: {
          text: sectionLabel,
          options: {
            x: 0.9,
            y: CONTENT_TOP,
            w: 4.9,
            h: 0.3,
            fontFace: FONT,
            fontSize: 16,
            color: dark ? COVER_EYE : slideAccentTextColor(`#${accent}`).slice(1),
            bold: true,
            charSpacing: 1.2,
            margin: 0,
          },
        },
      });
    }
    objects.push(...footerMasterObjects(dark));

    if (options.mirror) {
      objects.unshift({
        rect: {
          x: 13.08,
          y: 0,
          w: 0.25,
          h: SLIDE_HEIGHT,
          fill: { color: accent, transparency: 76 },
          line: noLine,
        },
      });
    }
    return objects;
  }

  function defineBodyMaster(
    title: string,
    sectionLabel: string,
    options: { dark?: boolean; mirror?: boolean; background?: string } = {}
  ): void {
    pres.defineSlideMaster({
      title,
      background: {
        color:
          options.background ?? (options.dark ? NAVY : options.mirror ? "F8FAFD" : "FFFFFF"),
      },
      objects: bodyMasterObjects(sectionLabel, options),
    });
  }

  pres.defineSlideMaster({
    title: MASTER.cover,
    background: { color: NAVY },
    objects: [
      {
        rect: {
          x: 0,
          y: 0,
          w: 0.22,
          h: SLIDE_HEIGHT,
          fill: { color: accent },
          line: noLine,
        },
      },
      {
        placeholder: {
          options: {
            name: "coverTitle",
            type: "title",
            x: 0.9,
            y: 2.72,
            w: 11.55,
            h: 1.82,
            fontFace: FONT,
            fontSize: 52,
            color: "FFFFFF",
            bold: true,
            valign: "top",
            margin: 0,
          },
          text: "",
        },
      },
      {
        rect: {
          x: 0.92,
          y: 4.77,
          w: 1.75,
          h: 0.07,
          fill: { color: accent },
          line: noLine,
        },
      },
      {
        placeholder: {
          options: {
            name: "coverSubtitle",
            type: "body",
            x: 0.92,
            y: 5.04,
            w: 11.45,
            h: 0.52,
            fontFace: FONT,
            fontSize: 18,
            color: COVER_SUB,
            margin: 0,
          },
          text: "",
        },
      },
    ],
  });
  defineBodyMaster(MASTER.objectives, "오늘 교육이 끝나면");
  defineBodyMaster(MASTER.process, "현장 절차");
  defineBodyMaster(MASTER.checklist, "현장 확인 체크");
  defineBodyMaster(MASTER.checklistFeatured, "현장 확인 체크", { mirror: true });
  defineBodyMaster(MASTER.scenario, "상황을 읽고 대응합니다");
  defineBodyMaster(MASTER.comparison, "두 기준을 나란히 비교합니다");
  defineBodyMaster(MASTER.timeline, "시간 흐름에 따라 확인합니다");
  defineBodyMaster(MASTER.decision, "조건에 따라 다음 행동을 결정합니다");
  defineBodyMaster(MASTER.visual, "원문 시각자료와 함께 확인합니다", {
    background: "FBFCFE",
  });
  defineBodyMaster(MASTER.summary, "교육 핵심 정리", { dark: true });
  defineBodyMaster(MASTER.content, "핵심 메시지");
  defineBodyMaster(MASTER.contentMirror, "핵심 메시지", { mirror: true });
  defineBodyMaster(MASTER.sources, "");

  function addFooter(slide: PptxSlide, page: number, total: number, dark = false): void {
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
    slide.addText(
      [
        {
          text: title,
          options: {
            fontFace: FONT,
            fontSize: headerTitleFontSize(title),
            color: dark ? "FFFFFF" : INK,
            bold: true,
          },
        },
      ],
      {
        placeholder: "slideTitle",
        ...BODY_TITLE_BOX,
        align: "left",
        valign: "middle",
        margin: 0,
        wrap: true,
      }
    );
    addFooter(slide, page, total, dark);
  }

  function renderSlideBody(slide: PptxSlide, s: GeneratedSlide, occurrence: number): void {
    const plan = buildSlideLayoutPlan(s, deckMode, occurrence);
    const colors: Record<SlideColor, string> = {
      ink: INK, body: BODY, accent, muted: GRAY, tint: TINT,
      white: "FFFFFF", line: HAIR,
    };
    for (const shape of plan.shapes) {
      slide.addShape(shape.kind, {
        x: shape.x, y: shape.y, w: shape.w, h: shape.h,
        ...(shape.kind === "roundRect" ? { rectRadius: 0.08 } : {}),
        ...(shape.fill ? { fill: { color: colors[shape.fill] } } : {}),
        line: shape.stroke
          ? { color: colors[shape.stroke], width: 1.5, ...(shape.arrow ? { endArrowType: "triangle" as const } : {}) }
          : noLine,
      });
    }
    if (plan.image) {
      const box = plan.image;
      if (isSafeSlideImageData(s.visual?.imageData)) {
        slide.addImage({
          data: s.visual.imageData, ...box,
          sizing: { type: s.visual.fit === "cover" ? "cover" : "contain", w: box.w, h: box.h },
          altText: s.visual.altText?.trim() || "근거 문서의 원문 시각자료",
          objectName: "근거 원문 시각자료",
        });
      } else {
        slide.addShape("roundRect", { ...box, fill: { color: TINT }, line: { color: accent, width: 1.2, dashType: "dash" } });
        slide.addText(s.visual?.altText?.trim() || "원문 그림을 확인해 주세요", {
          ...box, fontFace: FONT, fontSize: 20, color: GRAY,
          align: "center", valign: "middle", margin: 0.2,
        });
      }
    }
    for (const item of plan.texts) {
      slide.addText(item.text, {
        x: item.x, y: item.y, w: item.w, h: item.h,
        fontFace: FONT, fontSize: item.fontSize,
        color: item.color === "accent" ? slideAccentTextColor(`#${accent}`, plan.dark).slice(1) : colors[item.color],
        bold: item.bold, align: item.align ?? "left", valign: "top",
        margin: 0, breakLine: false, wrap: true, lineSpacingMultiple: 1.12,
        objectName: item.id,
      });
    }
  }

  function masterNameFor(layout: RenderLayout, occurrence: number): string {
    switch (layout) {
      case "objectives":
        return MASTER.objectives;
      case "process":
        return MASTER.process;
      case "checklist":
        return occurrence % 2 === 0 ? MASTER.checklist : MASTER.checklistFeatured;
      case "scenario":
        return MASTER.scenario;
      case "comparison":
        return MASTER.comparison;
      case "timeline":
        return MASTER.timeline;
      case "decision-flow":
        return MASTER.decision;
      case "visual-explanation":
        return MASTER.visual;
      case "summary":
        return MASTER.summary;
      default:
        return occurrence % 2 === 0 ? MASTER.content : MASTER.contentMirror;
    }
  }

  // ───────── 표지 ─────────
  const cover = pres.addSlide({ masterName: MASTER.cover });
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
    placeholder: "coverTitle",
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
  });
  cover.addText(subtitle, {
    placeholder: "coverSubtitle",
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
  const layoutOccurrences = new Map<RenderLayout, number>();

  // ───────── 본문 ─────────
  deck.slides.forEach((rawSlide, index) => {
    const s = rawSlide;
    const layout = buildSlideLayoutPlan(s, deckMode).layout;
    const occurrence = layoutOccurrences.get(layout) ?? 0;
    layoutOccurrences.set(layout, occurrence + 1);
    const slide = pres.addSlide({ masterName: masterNameFor(layout, occurrence) });
    const dark = layout === "summary";
    addHeader(slide, s.title, index + 1, total, dark);

    renderSlideBody(slide, s, occurrence);

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
  for (let index = 0; index < deck.sources.length; index += PPTX_SOURCES_PER_APPENDIX_SLIDE) {
    sourceChunks.push(deck.sources.slice(index, index + PPTX_SOURCES_PER_APPENDIX_SLIDE));
  }

  sourceChunks.forEach((sources, chunkIndex) => {
    const last = pres.addSlide({ masterName: MASTER.sources });
    const title = sourceChunks.length > 1 ? `근거 자료 ${chunkIndex + 1}` : "근거 자료";
    last.addText(title, {
      placeholder: "slideTitle",
      ...BODY_TITLE_BOX,
      fontFace: FONT,
      fontSize: 35,
      color: INK,
      bold: true,
      valign: "middle",
      margin: 0,
      wrap: false,
    });

    sources.forEach((source, index) => {
      const y = 1.72 + index * 0.72;
      last.addText(
        String(chunkIndex * PPTX_SOURCES_PER_APPENDIX_SLIDE + index + 1).padStart(2, "0"),
        {
          x: 0.82,
          y,
          w: 0.58,
          h: 0.35,
          fontFace: FONT,
          fontSize: MIN_BODY_FONT_SIZE,
          color: accent,
          bold: true,
          margin: 0,
        }
      );
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

  const rawBytes = await pres.write({ outputType: "uint8array", compression: false });
  const normalizedBytes =
    rawBytes instanceof Uint8Array
      ? rawBytes
      : rawBytes instanceof ArrayBuffer
        ? new Uint8Array(rawBytes)
        : null;
  if (!normalizedBytes) {
    throw new Error("PPTX 바이너리 생성에 실패했습니다.");
  }
  return normalizePptxPackage(normalizedBytes);
}

export async function downloadPptx(
  deck: GeneratedSlideDeck,
  category: string,
  subtitle: string
): Promise<void> {
  const bytes = await buildPptxBytes(deck, category, subtitle);
  const blobBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(blobBuffer).set(bytes);
  const blob = new Blob([blobBuffer], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFilename(deck.title)}.pptx`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
