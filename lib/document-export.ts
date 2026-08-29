import type { GeneratedDoc, GeneratedDocSource } from "@/lib/generate";

// 과거 저장본처럼 허용 출처 목록이 없는 문서도 정리할 수 있도록, 페이지 번호가
// 명시된 일반적인 인라인 인용은 별도로 인식한다. 시간·SOP 적용 표식 등 다른
// 대괄호 표기는 p.페이지 형식이 아니므로 보존된다.
const PAGED_INLINE_SOURCE_REF =
  /\[\s*(?:(?:근거|출처)\s*[:：]\s*)?[^\[\]\r\n]*?\bp\s*\.?\s*\d+(?:\s*[-–~,]\s*\d+)?[^\[\]\r\n]*?\]/gi;

export const DOCUMENT_SOURCE_SECTION_TITLE = "근거 자료 및 출처";

function sourceLabel(source: Pick<GeneratedDocSource, "doc" | "page">): string {
  const doc = source.doc.replace(/\s+/g, " ").trim();
  return `[${doc}${source.page != null ? ` p.${source.page}` : ""}]`;
}

function knownSourceLabels(doc: GeneratedDoc): string[] {
  return Array.from(
    new Set(
      [
        ...(doc.sourceLabels ?? []),
        ...doc.sources.map((source) => sourceLabel(source)),
      ]
        .map((label) => label.trim())
        .filter((label) => label.startsWith("[") && label.endsWith("]"))
    )
  ).sort((left, right) => right.length - left.length);
}

function tidyCitationGap(line: string): string {
  return line
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/(?:,\s*)+([.!?]|$)/g, "$1")
    .replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ")
    .replace(/[ \t]+$/g, "");
}

/**
 * 본문의 검증용 인라인 출처 라벨만 제거한다.
 *
 * 품질 검사 입력·과거 저장본·사용자 편집본에는 검증용 라벨이 남아 있을 수 있다.
 * 사용자가 내려받는 최종 문서에서는 같은 근거를 문장마다 반복하지 않고 마지막
 * 근거 자료 및 출처 목록에 한 번만 표시한다.
 */
export function stripInlineDocumentSources(
  text: string,
  labels: readonly string[] = []
): string {
  let cleaned = text;
  for (const label of labels) {
    const normalized = label.trim();
    if (normalized) cleaned = cleaned.split(normalized).join("");
  }
  cleaned = cleaned.replace(PAGED_INLINE_SOURCE_REF, "");
  return cleaned.split("\n").map(tidyCitationGap).join("\n");
}

/** 중복을 제거한 최종 문서용 근거 자료 표시 문자열. */
export function documentSourceLines(
  sources: readonly Pick<GeneratedDocSource, "doc" | "page">[]
): string[] {
  const lines = new Set<string>();
  for (const source of sources) {
    const doc = source.doc.replace(/\s+/g, " ").trim();
    if (!doc) continue;
    const page =
      source.page != null && Number.isSafeInteger(source.page) && source.page > 0
        ? ` p.${source.page}`
        : "";
    lines.add(`${doc}${page}`);
  }
  return Array.from(lines);
}

/** 기존 본문 뒤에 근거 자료를 한 번만 붙인다(외부 HWPX 서버 평문/양식용). */
export function appendDocumentSources(
  body: string,
  sources: readonly Pick<GeneratedDocSource, "doc" | "page">[]
): string {
  const lines = documentSourceLines(sources);
  if (lines.length === 0) return body;
  return `${body.trimEnd()}\n\n${DOCUMENT_SOURCE_SECTION_TITLE}\n${lines
    .map((line) => `- ${line}`)
    .join("\n")}`;
}

/** DOCX·HWPX 내보내기가 공유하는 비파괴 정규화. */
export function prepareGeneratedDocForExport(doc: GeneratedDoc): GeneratedDoc {
  const labels = knownSourceLabels(doc);
  return {
    ...doc,
    sections: doc.sections.map((section) => ({
      ...section,
      content: stripInlineDocumentSources(section.content, labels),
    })),
    sources: [...doc.sources],
    sourceLabels: doc.sourceLabels ? [...doc.sourceLabels] : undefined,
  };
}
