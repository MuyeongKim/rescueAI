/** 생성 문서에서 이중 이스케이프된 한국어 항목 줄바꿈만 복원한다. */
export function normalizeDocumentText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
  // 코드·경로·URL 안의 \n은 문서 줄바꿈으로 해석하지 않는다.
  return normalized
    .split(/(```[\s\S]*?```|`[^`\n]*`|\b[A-Za-z]:\\[^\s]+|https?:\/\/[^\s]+)/g)
    .map((part, index) => index % 2 === 1 ? part : part.replace(
      /\\(?:r\\n|n|r)(?=(?:\\(?:r\\n|n|r))*\s*(?:[-·•▪◦‣\[]|\d+[.)]|\p{Script=Hangul}))/gu,
      "\n"
    ))
    .join("");
}
