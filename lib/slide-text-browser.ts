import { SLIDE_FONT_FAMILY, type SlideTextMeasurer } from "@/lib/slide-text";

let preparation: Promise<SlideTextMeasurer> | undefined;

/** 브라우저에서만 호출한다. 준비 실패를 숨기고 다른 글꼴로 다운로드하지 않는다. */
export function prepareSlideTextMeasurer(): Promise<SlideTextMeasurer> {
  if (preparation) return preparation;
  preparation = (async () => {
    if (typeof document === "undefined" || !document.fonts) throw new Error("슬라이드 글꼴을 확인할 수 없습니다.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([
        Promise.all([400, 700].map((weight) => document.fonts.load(`${weight} 32px "${SLIDE_FONT_FAMILY}"`, "구조 훈련 중단 확인"))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("슬라이드 글꼴을 불러오는 시간이 길어졌습니다. 다시 시도해 주세요.")), 30_000); }),
      ]);
      if (loaded.some((faces) => faces.length === 0) || ![400, 700].every((weight) => document.fonts.check(`${weight} 32px "${SLIDE_FONT_FAMILY}"`, "구조 훈련"))) {
        throw new Error("슬라이드 글꼴을 준비하지 못했습니다. 다시 시도해 주세요.");
      }
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("슬라이드 글자 크기를 확인하지 못했습니다.");
      const cache = new Map<string, number>();
      return ((text, fontSizePt, bold) => {
        const key = `${fontSizePt}:${bold ? 700 : 400}:${text}`;
        const existing = cache.get(key);
        if (existing !== undefined) return existing;
        context.font = `${bold ? 700 : 400} ${fontSizePt * 96 / 72}px "${SLIDE_FONT_FAMILY}"`;
        const widthPt = context.measureText(text.normalize("NFC")).width * 72 / 96;
        if (cache.size >= 5_000) cache.clear();
        cache.set(key, widthPt);
        return widthPt;
      }) satisfies SlideTextMeasurer;
    } finally { if (timer) clearTimeout(timer); }
  })().catch((error) => { preparation = undefined; throw error; });
  return preparation;
}
