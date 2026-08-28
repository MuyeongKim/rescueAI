import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadHwpx } from "@/lib/hwpx-download";
import type { GeneratedDoc } from "@/lib/generate";

const doc: GeneratedDoc = {
  title: "훈련계획",
  sections: [{ heading: "훈련 목표", content: "목표" }],
  sources: [],
};

describe("downloadHwpx", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("필수 항목 누락 응답은 로컬 양식으로 숨기지 않고 사용자에게 전달한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { error: "훈련계획 필수 항목이 비어 있습니다: 평가 기준" },
          { status: 422 }
        )
      )
    );

    await expect(
      downloadHwpx(doc, { template: "training_plan" })
    ).rejects.toThrow("평가 기준");
  });
});
