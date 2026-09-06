/** 사용자가 고른 원문 표시 범위. 관련 영역을 모델이나 임의 좌표로 추정하지 않는다. */
export const SOURCE_VISUAL_FOCUS = ["top", "middle", "bottom"] as const;
export type SourceVisualFocus = (typeof SOURCE_VISUAL_FOCUS)[number];
export const SOURCE_VISUAL_FOCUS_LABELS: Record<SourceVisualFocus, string> = {
  top: "상단 절반",
  middle: "가운데 절반",
  bottom: "하단 절반",
};

export function validSourceVisualFocus(value: unknown): SourceVisualFocus | undefined {
  return SOURCE_VISUAL_FOCUS.includes(value as SourceVisualFocus)
    ? value as SourceVisualFocus : undefined;
}

/** 회전이 반영된 PDF 화면 기준 정규화 범위. 가운데 범위는 위·아래 범위와 겹친다. */
export function sourceVisualFocusRegion(value: unknown) {
  const focus = validSourceVisualFocus(value);
  return { x: 0, y: focus === "middle" ? 0.25 : focus === "bottom" ? 0.5 : 0,
    width: 1, height: focus ? 0.5 : 1 };
}
