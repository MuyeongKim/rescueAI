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

  it("미니서버 요청에도 인라인 출처를 제거한 본문과 마지막 근거 목록을 전달한다", async () => {
    const inlineRef = "[로프구조 — 경사면 구조 p.44]";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ error: "검증 종료" }, { status: 422 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHwpx(
        {
          title: "경사면 구조 훈련계획",
          sections: [
            {
              heading: "훈련목표",
              content: `구조시스템을 결정할 수 있다 ${inlineRef}.`,
            },
          ],
          sources: [
            {
              document_id: 1,
              doc: "로프구조 — 경사면 구조",
              page: 44,
            },
          ],
          sourceLabels: [inlineRef],
        },
        { template: "training_plan" }
      )
    ).rejects.toThrow("검증 종료");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.sections[0].content).toBe("구조시스템을 결정할 수 있다.");
    expect(payload.sources).toEqual([
      {
        document_id: 1,
        doc: "로프구조 — 경사면 구조",
        page: 44,
      },
    ]);
  });
});
