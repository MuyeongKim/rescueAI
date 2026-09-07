export type ChatEvidenceState = "empty" | "degraded" | "insufficient" | "review_failed";

export function buildChatEvidenceFallback(state: ChatEvidenceState, category?: string | null): string {
  if (state === "review_failed") {
    return "답변 초안과 원문의 내용이 맞는지 확인하지 못해 답변을 보류했습니다. 잠시 후 같은 질문을 다시 시도하거나 자료실에서 해당 원문을 확인해 주세요.";
  }
  if (state === "degraded") {
    return "자료 검색 중 오류가 발생해 질문의 근거를 충분히 확인하지 못했습니다. 자료가 없다는 뜻은 아닙니다. 잠시 후 같은 질문을 다시 시도해 주세요. 급한 경우 자료실에서 원문을 직접 확인할 수 있습니다.";
  }
  const scope = category
    ? "현재 선택한 분야에서 "
    : "이번 검색에서 ";
  const opening = state === "insufficient"
    ? "검색한 자료로는 질문에 맞는 내용을 확인하지 못했습니다."
    : `${scope}답변에 필요한 근거를 찾지 못했습니다.`;
  return `${opening} 전체 자료에 내용이 없다는 뜻은 아닙니다.${category ? " 분야를 ‘자동’으로 바꿔 다시 검색할 수도 있습니다." : ""} 어떤 장비·평가 종목 또는 상황을 기준으로 설명하면 될까요?`;
}
