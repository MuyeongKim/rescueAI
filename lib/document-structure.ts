import type { GeneratedSection } from "@/lib/generate";

type Span = { start: number; end: number };
export type TrainingTableRow = {
  name: string;
  minutes: string;
  body: string;
  minutesSpan: Span;
  bodySpan: Span;
};
export type EvaluationTableRow = {
  cells: [string, string, string, string];
  spans: [Span, Span, Span, Span];
  lineSpan: Span;
};

function trimmedSpan(text: string, start: number, end: number): Span {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return { start: start + leading, end: Math.max(start + leading, end - trailing) };
}

/** 표 입력은 원래 문자열의 해당 구간만 바꾼다. 주석·SOP·다른 항목을 재작성하지 않는다. */
export function replaceDocumentSpan(text: string, span: Span, value: string): string {
  return text.slice(0, span.start) + value + text.slice(span.end);
}

/** 여러 줄 셀은 CSV와 같은 인용 규칙을 쓴다. 일반 문단·다른 행은 변경하지 않는다. */
export function replaceEvaluationCell(text: string, row: EvaluationTableRow, index: number, value: string): string {
  const encoded = index > 0 && (/\r?\n|\s+\/\s+/.test(value) || value.startsWith('"'))
    ? `"${value.replace(/"/g, '""')}"`
    : value;
  return replaceDocumentSpan(text, row.spans[index], encoded);
}

export function trainingTableRows(section: GeneratedSection): TrainingTableRow[] {
  if (!["훈련내용", "도입", "핵심이론", "교관시범", "대원실습", "안전유의사항", "정리·평가"].includes(section.heading)) return [];
  const text = section.content;
  const markers = Array.from(text.matchAll(/\[(?:([^\]\n]{1,50}?)\s*[·•∙]\s*|시간\s*[:：]\s*)(\d+)\s*분\]/g));
  return markers.map((match, index) => {
    const start = match.index!;
    const minutesOffset = match[0].lastIndexOf(match[2]);
    const bodySpan = trimmedSpan(text, start + match[0].length, markers[index + 1]?.index ?? text.length);
    return {
      name: match[1]?.trim() || section.heading,
      minutes: match[2],
      body: text.slice(bodySpan.start, bodySpan.end),
      minutesSpan: { start: start + minutesOffset, end: start + minutesOffset + match[2].length },
      bodySpan,
    };
  });
}

/** 기존 평가 문장의 명시적인 네 칸만 읽는다. 모호한 문장은 원문 편집으로 남긴다. */
export function evaluationTableRows(section: GeneratedSection): EvaluationTableRow[] {
  if (!["훈련평가", "정리·평가"].includes(section.heading)) return [];
  const rows: EvaluationTableRow[] = [];
  // 따옴표 안에서만 실제 줄바꿈을 허용하므로 다음 일반 문단을 표에 합치지 않는다.
  const pattern = /^([ \t]*(?:[-·•][ \t]*|\d+[.)][ \t]*))(.*?)([ \t]+[—–][ \t]+)("(?:[^"]|"")*"|[^\n]*?)([ \t]+\/[ \t]+)("(?:[^"]|"")*"|[^\n]*?)([ \t]+\/[ \t]+)("(?:[^"]|"")*"|[^\n]*?)[ \t]*(?=\n|$)/gm;
  for (const match of section.content.matchAll(pattern)) {
    const values = [match[2], match[4], match[6], match[8]].map((value) => value.trim());
    if (values.slice(1).some((value) => !value.startsWith('"') && /\s+\/\s+/.test(value))) continue;
    let cursor = match.index!;
    const spans: Span[] = [];
    for (let group = 1; group <= 8; group++) {
      if (group % 2 === 0) spans.push(trimmedSpan(section.content, cursor, cursor + match[group].length));
      cursor += match[group].length;
    }
    rows.push({
      // 과거 본문의 자연스러운 "확인" 인용은 보존한다. 인코더가 만드는 특수 셀만 해제한다.
      cells: values.map((value, index) => index > 0 && value.startsWith('"') && value.endsWith('"')
        && (/\r?\n|\s+\/\s+/.test(value) || value.startsWith('"""'))
        ? value.slice(1, -1).replace(/""/g, '"') : value) as EvaluationTableRow["cells"],
      spans: spans as EvaluationTableRow["spans"],
      lineSpan: { start: match.index!, end: match.index! + match[0].length },
    });
  }
  return rows;
}

/** 평문 출력에만 적용한다. 편집·저장·표 파싱에는 인용된 원본 문자열을 유지한다. */
export function documentSectionPlainText(section: GeneratedSection): string {
  let content = section.content;
  for (const row of evaluationTableRows(section).reverse()) {
    for (let index = 3; index > 0; index--) {
      content = replaceDocumentSpan(content, row.spans[index], row.cells[index]);
    }
  }
  return content;
}

export type DocumentSectionBlock =
  | { type: "text"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

/** DOCX·화면이 같은 표를 보여 주며 표로 읽지 못한 문장은 순서대로 보존한다. */
export function documentSectionBlocks(section: GeneratedSection): DocumentSectionBlock[] {
  const evaluations = evaluationTableRows(section);
  if (evaluations.length > 0) {
    const blocks: DocumentSectionBlock[] = [];
    let cursor = 0;
    for (const row of evaluations) {
      const gap = section.content.slice(cursor, row.lineSpan.start);
      if (gap.trim()) blocks.push({ type: "text", text: gap });
      const previous = blocks.at(-1);
      if (!gap.trim() && previous?.type === "table") previous.rows.push(row.cells);
      else blocks.push({ type: "table", headers: ["평가항목", "관찰 가능한 수행 기준", "통과 판단", "미달 시 피드백·재수행"], rows: [row.cells] });
      cursor = row.lineSpan.end;
    }
    if (section.content.slice(cursor).trim()) blocks.push({ type: "text", text: section.content.slice(cursor) });
    return blocks;
  }
  const training = trainingTableRows(section);
  if (training.length > 0) {
    const firstMarker = section.content.lastIndexOf("[", training[0].minutesSpan.start);
    const preamble = section.content.slice(0, firstMarker);
    return [
      ...(preamble.trim() ? [{ type: "text" as const, text: preamble }] : []),
      { type: "table", headers: ["단계", "시간", "교육 진행 · 행동 · 확인"], rows: training.map((row) => [row.name, `${row.minutes}분`, row.body]) },
    ];
  }
  return [{ type: "text", text: section.content }];
}
