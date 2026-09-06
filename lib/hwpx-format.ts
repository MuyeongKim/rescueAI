import { normalizeDocumentText } from "@/lib/document-text";

export type HwpxParagraphKind = "body" | "bullet" | "label" | "blank";

export type HwpxParagraph = {
  text: string;
  kind: HwpxParagraphKind;
};

const INLINE_PHASE_MARKER =
  /\s+(?=\[(?:이론교육|교관시범|반복실습|종합수행|대원실습|정리(?:·평가)?|강평|평가|관련 SOP 적용|SOP 적용)[^\]\n]{0,50}\])/g;
const INLINE_LIST_MARKER =
  /\s+(?=(?:[-·•▪◦‣]\s+|\d{1,2}[.)]\s+))/g;
const BULLET_LINE = /^(?:[-·•▪◦‣]\s*|\d{1,2}[.)]\s+)/;
const LABEL_LINE = /^\[[^\]\n]{2,80}\]/;

function splitCollapsedLine(line: string): string[] {
  const phases = line.replace(INLINE_PHASE_MARKER, "\n").split("\n");
  const parts: string[] = [];

  for (const phase of phases) {
    const trimmed = phase.trim();
    if (!trimmed) continue;
    const closingBracket = trimmed.startsWith("[") ? trimmed.indexOf("]") : -1;
    const protectedLabel = closingBracket >= 0 ? trimmed.slice(0, closingBracket + 1) : "";
    const remainder = closingBracket >= 0 ? trimmed.slice(closingBracket + 1).trim() : trimmed;
    const listParts = remainder
      .replace(INLINE_LIST_MARKER, "\n")
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean);

    if (protectedLabel) {
      parts.push(listParts[0] ? `${protectedLabel} ${listParts[0]}` : protectedLabel);
      parts.push(...listParts.slice(1));
    } else {
      parts.push(...listParts);
    }
  }

  return parts;
}

/**
 * 외부 HWPX 작성 서버가 줄 단위로 문단을 만들 수 있도록 입력 텍스트를 정규화한다.
 * 명시적 줄바꿈은 보존하고, 한 줄에 붙은 훈련 단계·목록 표지만 안전하게 분리한다.
 */
export function normalizeHwpxCellText(text: string): string {
  const normalized = normalizeDocumentText(text);
  const lines: string[] = [];

  for (const rawLine of normalized.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    lines.push(...splitCollapsedLine(trimmed));
  }

  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** HWPX 본문용 문단 유형을 결정해 제목·목록·일반 본문을 서로 다른 서식으로 연결한다. */
export function hwpxParagraphs(text: string): HwpxParagraph[] {
  const normalized = normalizeHwpxCellText(text);
  if (!normalized) return [];

  return normalized.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { text: "", kind: "blank" };
    if (LABEL_LINE.test(trimmed) || trimmed === "근거 자료 및 출처") {
      return { text: trimmed, kind: "label" };
    }
    if (BULLET_LINE.test(trimmed)) return { text: trimmed, kind: "bullet" };
    return { text: trimmed, kind: "body" };
  });
}
