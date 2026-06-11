// 생성 슬라이드(GeneratedSlideDeck) → PPTX 변환. 클라이언트에서 동적 import로만 사용.
// 배경·형식은 사전 지정 템플릿(분야 색 헤더 + 전북소방 푸터)이고 AI는 내용만 채운다.
import pptxgen from "pptxgenjs";
import type { GeneratedSlideDeck } from "@/lib/generate";
import { categoryStyle } from "@/lib/category";

const FONT = "Pretendard";
const DARK = "1F2937"; // 본문 잉크
const GRAY = "6B7280"; // 보조 텍스트

function hexOf(category: string): string {
  return categoryStyle(category).hex.replace("#", "");
}

export async function downloadPptx(
  deck: GeneratedSlideDeck,
  category: string,
  subtitle: string
): Promise<void> {
  const accent = hexOf(category);
  const pres = new pptxgen();
  pres.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pres.layout = "WIDE";

  // ── 표지 ──
  const cover = pres.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addShape("rect", { x: 0, y: 0, w: 13.33, h: 0.35, fill: { color: accent } });
  cover.addShape("rect", { x: 0, y: 7.15, w: 13.33, h: 0.35, fill: { color: accent } });
  cover.addText(`${category} 분야 교육`, {
    x: 0.8, y: 2.0, w: 11.7, h: 0.6,
    fontFace: FONT, fontSize: 20, color: accent, bold: true,
  });
  cover.addText(deck.title, {
    x: 0.8, y: 2.6, w: 11.7, h: 1.8,
    fontFace: FONT, fontSize: 40, color: DARK, bold: true,
  });
  cover.addText(subtitle, {
    x: 0.8, y: 4.6, w: 11.7, h: 0.5,
    fontFace: FONT, fontSize: 16, color: GRAY,
  });
  cover.addText("전북특별자치도 소방본부 · AI 생성 초안 (시행 전 검토 필요)", {
    x: 0.8, y: 6.4, w: 11.7, h: 0.4,
    fontFace: FONT, fontSize: 12, color: GRAY,
  });

  // ── 본문 ──
  deck.slides.forEach((s, i) => {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };
    // 분야 색 헤더 바
    slide.addShape("rect", { x: 0, y: 0, w: 13.33, h: 1.0, fill: { color: accent } });
    slide.addText(s.title, {
      x: 0.6, y: 0.12, w: 11.0, h: 0.76,
      fontFace: FONT, fontSize: 24, color: "FFFFFF", bold: true, valign: "middle",
    });
    slide.addText(`${i + 1}`, {
      x: 12.2, y: 0.12, w: 0.8, h: 0.76,
      fontFace: FONT, fontSize: 14, color: "FFFFFF", align: "right", valign: "middle",
    });
    // 핵심 문장 (불릿)
    slide.addText(
      s.bullets.map((b) => ({
        text: b,
        options: { bullet: { code: "2022", indent: 18 }, breakLine: true },
      })),
      {
        x: 0.9, y: 1.5, w: 11.5, h: 5.0,
        fontFace: FONT, fontSize: 20, color: DARK,
        lineSpacingMultiple: 1.5, valign: "top",
      }
    );
    // 푸터
    slide.addText("전북소방 구조 교육훈련 플랫폼", {
      x: 0.6, y: 7.05, w: 6, h: 0.35,
      fontFace: FONT, fontSize: 10, color: GRAY,
    });
    if (s.notes) slide.addNotes(s.notes);
  });

  // ── 근거 자료 ──
  if (deck.sources.length > 0) {
    const last = pres.addSlide();
    last.background = { color: "FFFFFF" };
    last.addShape("rect", { x: 0, y: 0, w: 13.33, h: 1.0, fill: { color: accent } });
    last.addText("근거 자료", {
      x: 0.6, y: 0.12, w: 11.0, h: 0.76,
      fontFace: FONT, fontSize: 24, color: "FFFFFF", bold: true, valign: "middle",
    });
    last.addText(
      deck.sources.map((src) => ({
        text: `${src.doc}${src.page != null ? ` (p.${src.page})` : ""}`,
        options: { bullet: { code: "2022", indent: 18 }, breakLine: true },
      })),
      {
        x: 0.9, y: 1.5, w: 11.5, h: 5.0,
        fontFace: FONT, fontSize: 18, color: DARK,
        lineSpacingMultiple: 1.5, valign: "top",
      }
    );
  }

  await pres.writeFile({ fileName: `${deck.title.slice(0, 50)}.pptx` });
}
