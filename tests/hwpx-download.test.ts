import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import { downloadHwpx } from "@/lib/hwpx-download";
import type { GeneratedDoc } from "@/lib/generate";

const doc: GeneratedDoc = {
  title: "훈련계획",
  sections: [{ heading: "훈련 목표", content: "목표" }],
  sources: [],
};

describe("downloadHwpx", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function captureDownload() {
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => { blob = value as Blob; return "blob:download"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", click: vi.fn() }) });
    return async () => {
      expect(blob).toBeInstanceOf(Blob);
      const zip = await JSZip.loadAsync(await blob!.arrayBuffer());
      return zip.file("Contents/section0.xml")!.async("string");
    };
  }

  it.each([501, 502, "offline"])("%s 로컬 대체 파일도 입력한 훈련 정보를 본문과 함께 보존한다", async (failure) => {
    const fetcher = failure === "offline" ? vi.fn().mockRejectedValue(new TypeError("offline"))
      : vi.fn().mockResolvedValue(new Response(null, { status: Number(failure) }));
    vi.stubGlobal("fetch", fetcher);
    const downloadedXml = captureDownload();
    const original = structuredClone(doc);
    const plan = { topic: "로프 하강", datetime: "2026-09-06", place: "훈련탑 A & B", target: "일반 대원", duration: "2시간", formType: "자체 훈련", method: "반복 실습" };
    expect(await downloadHwpx(doc, { template: "training_plan", plan })).toBe("local");
    const xml = await downloadedXml();
    for (const line of ["훈련 정보", "훈련주제: 로프 하강", "훈련일시: 2026-09-06", "훈련장소: 훈련탑 A &amp; B", "훈련대상: 일반 대원", "교육시간: 2시간", "훈련구분: 자체 훈련", "훈련방법: 반복 실습", "훈련 목표", "목표"]) {
      expect(xml).toContain(line);
    }
    expect(doc).toEqual(original);
    const serverPayload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(serverPayload.sections).toEqual(original.sections);
    expect(serverPayload.plan).toEqual(plan);
  });

  it("일반 문서 로컬 양식에는 훈련계획 메타 섹션을 추가하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 501 })));
    const downloadedXml = captureDownload();
    expect(await downloadHwpx(doc)).toBe("local");
    const xml = await downloadedXml();
    expect(xml).not.toContain("훈련 정보"); expect(xml).toContain("훈련 목표");
  });

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
