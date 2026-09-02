import type { DocSource } from "@/lib/database.types";
import { stripInlineDocumentSources } from "@/lib/document-export";

export const CHAT_SOURCE_SECTION_TITLE = "근거 자료";

/** 모델이 남긴 인라인 페이지 인용을 숨겨 출처를 답변 마지막 영역에만 표시한다. */
export function prepareChatAnswerText(text: string): string {
  return stripInlineDocumentSources(text);
}

/** 과거 저장본과 검색 결과의 중복 출처를 화면·저장 전에 한 번 더 정리한다. */
export function uniqueChatSources(sources: readonly DocSource[]): DocSource[] {
  const seen = new Set<string>();
  const unique: DocSource[] = [];

  for (const source of sources) {
    const normalizedDoc = source.doc.replace(/\s+/g, " ").trim();
    if (!normalizedDoc) continue;
    const identity =
      source.document_id > 0
        ? `id:${source.document_id}`
        : `doc:${normalizedDoc.toLocaleLowerCase("ko-KR")}`;
    const key = `${identity}::${source.page ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }

  return unique;
}
