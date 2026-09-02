import { describe, expect, it } from "vitest";

import {
  estimatedGenerationStage,
  formatApproximateDuration,
  formatElapsedSeconds,
  generationEstimateSeconds,
} from "@/lib/generation-timing";

describe("자료제작 예상시간 표시", () => {
  it("산출물 분량에 맞춰 보수적인 완료 예상값을 정한다", () => {
    expect(generationEstimateSeconds("plan", "1시간")).toBe(420);
    expect(generationEstimateSeconds("lesson", "4시간")).toBe(540);
    expect(generationEstimateSeconds("slides", "1시간")).toBe(720);
    expect(generationEstimateSeconds("slides", "2시간")).toBe(960);
    expect(generationEstimateSeconds("slides", "4시간")).toBe(1_200);
  });

  it("경과시간과 사용자 안내용 기간을 음수 없이 표시한다", () => {
    expect(formatElapsedSeconds(-1)).toBe("00:00");
    expect(formatElapsedSeconds(59)).toBe("00:59");
    expect(formatElapsedSeconds(60)).toBe("01:00");
    expect(formatElapsedSeconds(3_661)).toBe("1:01:01");
    expect(formatApproximateDuration(285)).toBe("4분 45초");
  });

  it("실제 진행률로 오해하지 않도록 시간대별 예상 단계만 반환한다", () => {
    expect(estimatedGenerationStage(0, 180)).toBe("관련 교범과 SOP를 찾는 중");
    expect(estimatedGenerationStage(60, 180)).toBe("정밀 모델이 초안을 작성하는 중");
    expect(estimatedGenerationStage(170, 180)).toBe("구성·분량·출처를 점검하는 중");
  });
});
