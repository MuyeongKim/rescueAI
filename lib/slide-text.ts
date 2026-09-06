/** PPTX와 웹 미리보기의 글자 배치 계약. 폭·글꼴 크기는 pt, 박스는 inch. */
export const SLIDE_FONT_FAMILY = "Noto Sans KR";
export const SLIDE_LINE_HEIGHT = 1.25;
export const MIN_SLIDE_TEXT_PT = 16;
export type SlideTextMeasurer = (text: string, fontSizePt: number, bold: boolean) => number;
export type SlideTextBox = { x: number; y: number; w: number; h: number };

/** 서버에서는 폰트 파일/DOM에 의존하지 않고 넉넉한 글폭으로 검사한다. */
export const conservativeSlideTextMeasure: SlideTextMeasurer = (text, size) =>
  Array.from(text.normalize("NFC")).reduce((sum, character) => sum + size * (
    /\s/.test(character) ? 0.36 : /[MW@#%]/.test(character) ? 1 :
      /^[\x00-\x7f]$/.test(character) ? 0.68 : 1.04
  ), 0);

/** 여는 괄호는 다음 글자, 닫는 괄호·마침표는 앞 글자에 붙여 외톨이 문장부호를 막는다. */
function wrappingUnits(paragraph: string): string[] {
  const units: string[] = [];
  let opening = "";
  for (const character of Array.from(paragraph)) {
    const previous = units.at(-1);
    const openingQuote = /^["']$/.test(character) && (!previous || /\s$/.test(previous) || opening.length > 0);
    if (/^[([{“‘]$/.test(character) || openingQuote) {
      opening += character;
    } else if (opening) {
      opening += character;
      if (!/\s/.test(character)) { units.push(opening); opening = ""; }
    } else if (/^[.,;:!?%…。，、！？：；)\]}”’"']$/.test(character) && previous && !/\s$/.test(previous)) {
      units[units.length - 1] += character;
    } else units.push(character);
  }
  if (opening) units.push(opening);
  return units;
}

export function wrapSlideText(text: string, widthPt: number, fontSize: number, bold = false,
  measureText: SlideTextMeasurer = conservativeSlideTextMeasure): string[] {
  const result: string[] = [];
  for (const paragraph of text.normalize("NFC").split("\n")) {
    let line: string[] = [];
    for (const unit of wrappingUnits(paragraph)) {
      const current = line.join("");
      if (current && measureText(current + unit, fontSize, bold) > widthPt) {
        // 가능한 경우 단어 사이에서 줄을 바꾸고, 긴 한글 단어도 빠뜨리지 않는다.
        const space = line.findLastIndex((value) => /^\s$/.test(value));
        if (space >= 0 && line.slice(0, space).join("").length > current.length * 0.4 && !/^\s$/.test(unit)) {
          result.push(line.slice(0, space).join("").trimEnd());
          line = [...line.slice(space + 1), unit];
        } else {
          result.push(current.trimEnd());
          line = unit.trimStart() ? [unit.trimStart()] : [];
        }
      } else line.push(unit);
    }
    result.push(line.join("").trimEnd());
  }
  return result;
}

export function fitSlideText(text: string, box: SlideTextBox, sizes: readonly number[], bold = false,
  measureText: SlideTextMeasurer = conservativeSlideTextMeasure) {
  const candidates = [...new Set(sizes.map((size) => Math.max(MIN_SLIDE_TEXT_PT, size)))];
  let last = { fontSize: candidates[0] ?? MIN_SLIDE_TEXT_PT, lines: [text], fits: false, requiredHeight: 0 };
  for (const fontSize of candidates.length ? candidates : [MIN_SLIDE_TEXT_PT]) {
    const lines = wrapSlideText(text, Math.max(1, box.w * 72 - 1.5), fontSize, bold, measureText);
    const requiredHeight = (lines.length * SLIDE_LINE_HEIGHT + 0.08) * fontSize / 72;
    const fits = requiredHeight <= box.h + 0.001 && lines.every((line) => measureText(line, fontSize, bold) <= box.w * 72);
    last = { fontSize, lines, fits, requiredHeight };
    if (fits) return last;
  }
  return last;
}
