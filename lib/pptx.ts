// 생성 슬라이드(GeneratedSlideDeck) → PPTX 변환. 클라이언트에서 동적 import로만 사용.
// 디자인: 전북소방 표준 발표자료(업로드 서식)의 언어를 코드화 —
//   다크 네이비 표지 + 강조색(분야색) 포인트 + 번호 칩 제목 + 헤어라인 구분선 + 절제된 타이포.
// AI는 내용(제목·핵심문장·발표자노트)만 채우고, 이 레이아웃이 매번 세련되게 입혀진다.
import pptxgen from "pptxgenjs";
import type { GeneratedSlideDeck } from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { sanitizeFilename } from "@/lib/utils";

const FONT = "Noto Sans KR"; // 업로드 서식과 동일 계열(공직 PC 기본 설치)
const INK = "1A2B4A"; // 본문 제목 잉크(딥 네이비)
const BODY = "2B3648"; // 본문 텍스트
const NAVY = "12233F"; // 표지 배경
const GRAY = "6B7280"; // 보조
const HAIR = "E5E7EB"; // 헤어라인
const TINT = "F4F6F9"; // 단계 바 배경(연한 중립)
const COVER_SUB = "C8D2E0"; // 표지 부제(네이비 위)
const COVER_EYE = "9FB0CB"; // 표지 아이라벨
const COVER_FADE = "7C8AA6"; // 표지 안내문

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
  const noLine = { type: "none" as const };

  // ───────── 표지 ─────────
  const cover = pres.addSlide();
  cover.background = { color: NAVY };
  // 좌측 강조 바 + 상단 얇은 라인
  cover.addShape("rect", { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: accent }, line: noLine });
  // 아이라벨
  cover.addText(`전북특별자치도 소방본부  ·  ${category} 분야`, {
    x: 0.9, y: 2.35, w: 11.5, h: 0.4,
    fontFace: FONT, fontSize: 14, color: COVER_EYE, bold: true, charSpacing: 2,
  });
  // 제목
  cover.addText(deck.title, {
    x: 0.86, y: 2.85, w: 11.6, h: 1.9,
    fontFace: FONT, fontSize: 44, color: "FFFFFF", bold: true, valign: "top", lineSpacingMultiple: 1.05,
  });
  // 제목 아래 강조 언더라인
  cover.addShape("rect", { x: 0.9, y: 4.78, w: 1.7, h: 0.07, fill: { color: accent }, line: noLine });
  // 부제(대상·시간)
  cover.addText(subtitle, {
    x: 0.9, y: 5.05, w: 11.5, h: 0.5,
    fontFace: FONT, fontSize: 16, color: COVER_SUB,
  });
  // 안내문
  cover.addText("AI 생성 초안 — 시행 전 담당자 검토가 필요합니다.", {
    x: 0.9, y: 6.75, w: 11.5, h: 0.4,
    fontFace: FONT, fontSize: 11, color: COVER_FADE,
  });

  const total = deck.slides.length;

  // ───────── 본문 ─────────
  deck.slides.forEach((s, i) => {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };

    // 번호 칩(강조색) + 제목
    slide.addShape("roundRect", {
      x: 0.62, y: 0.55, w: 0.64, h: 0.64, rectRadius: 0.1,
      fill: { color: accent }, line: noLine,
    });
    slide.addText(String(i + 1), {
      x: 0.62, y: 0.55, w: 0.64, h: 0.64,
      fontFace: FONT, fontSize: 22, color: "FFFFFF", bold: true, align: "center", valign: "middle",
    });
    slide.addText(s.title, {
      x: 1.45, y: 0.55, w: 11.3, h: 0.64,
      fontFace: FONT, fontSize: 26, color: INK, bold: true, valign: "middle",
    });
    // 제목 아래 헤어라인
    slide.addShape("rect", { x: 0.62, y: 1.4, w: 12.1, h: 0.02, fill: { color: HAIR }, line: noLine });

    // 단계(흐름) 다이어그램 — steps 가 있으면 제목 아래 화살표 바로 표시
    const steps = (s.steps ?? []).filter((x) => x && x.trim()).slice(0, 5);
    let bodyTop = 1.75;
    if (steps.length >= 2) {
      slide.addShape("roundRect", {
        x: 0.9, y: 1.56, w: 11.53, h: 0.52, rectRadius: 0.06,
        fill: { color: TINT }, line: noLine,
      });
      slide.addText(steps.join("      ▸      "), {
        x: 1.0, y: 1.56, w: 11.33, h: 0.52,
        fontFace: FONT, fontSize: 13, color: accent, bold: true,
        align: "center", valign: "middle",
      });
      bodyTop = 2.35;
    }

    // 핵심 문장(불릿)
    slide.addText(
      s.bullets.map((b) => ({
        text: b,
        options: { bullet: { code: "25AA", indent: 22 }, breakLine: true, paraSpaceAfter: 10 },
      })),
      {
        x: 0.9, y: bodyTop, w: 11.6, h: 6.85 - bodyTop,
        fontFace: FONT, fontSize: 20, color: BODY,
        lineSpacingMultiple: 1.4, valign: "top",
      }
    );

    // 푸터: 헤어라인 + 좌 기관명 + 우 페이지
    slide.addShape("rect", { x: 0.62, y: 7.0, w: 12.1, h: 0.015, fill: { color: HAIR }, line: noLine });
    slide.addText("전북특별자치도 소방본부", {
      x: 0.62, y: 7.05, w: 8, h: 0.32,
      fontFace: FONT, fontSize: 9, color: GRAY,
    });
    slide.addText(`${i + 1} / ${total}`, {
      x: 10.72, y: 7.05, w: 2.0, h: 0.32,
      fontFace: FONT, fontSize: 9, color: accent, bold: true, align: "right",
    });
    if (s.notes) slide.addNotes(s.notes);
  });

  // ───────── 근거 자료 ─────────
  if (deck.sources.length > 0) {
    const last = pres.addSlide();
    last.background = { color: "FFFFFF" };
    last.addText("근거 자료", {
      x: 0.62, y: 0.55, w: 11.3, h: 0.64,
      fontFace: FONT, fontSize: 26, color: INK, bold: true, valign: "middle",
    });
    last.addShape("rect", { x: 0.62, y: 1.4, w: 12.1, h: 0.02, fill: { color: HAIR }, line: noLine });
    last.addText(
      deck.sources.map((src) => ({
        text: `${src.doc}${src.page != null ? ` (p.${src.page})` : ""}`,
        options: { bullet: { code: "25AA", indent: 22 }, breakLine: true, paraSpaceAfter: 8 },
      })),
      {
        x: 0.9, y: 1.75, w: 11.6, h: 4.9,
        fontFace: FONT, fontSize: 16, color: BODY,
        lineSpacingMultiple: 1.4, valign: "top",
      }
    );
  }

  await pres.writeFile({ fileName: `${sanitizeFilename(deck.title)}.pptx` });
}
