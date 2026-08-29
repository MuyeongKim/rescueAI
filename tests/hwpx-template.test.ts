import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildHwpxFiles } from "@/lib/hwpx";
import { normalizeTrainingPlanHwpx } from "@/lib/hwpx-template";

const HH_NS = "http://www.hancom.co.kr/hwpml/2011/head";
const HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph";
const HC_NS = "http://www.hancom.co.kr/hwpml/2011/core";

function sampleHeader() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="${HH_NS}" xmlns:hc="${HC_NS}">
  <hh:paraPr id="0">
    <hh:align horizontal="JUSTIFY"/>
    <hh:margin><hc:intent value="-100"/></hh:margin>
  </hh:paraPr>
  <hh:paraPr id="48">
    <hh:align horizontal="JUSTIFY"/>
    <hh:margin><hc:intent value="-2200"/></hh:margin>
  </hh:paraPr>
</hh:head>`;
}

function sampleSection() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hp:sec xmlns:hp="${HP_NS}">
  <hp:tbl>
    <hp:tc>
      <hp:subList vertAlign="CENTER">
        <hp:p paraPrIDRef="48"><hp:run><hp:t>첫 번째 단계</hp:t></hp:run></hp:p>
        <hp:p paraPrIDRef="48"><hp:run><hp:t>두 번째 단계</hp:t></hp:run></hp:p>
        <hp:p paraPrIDRef="48"><hp:run><hp:t></hp:t></hp:run></hp:p>
      </hp:subList>
      <hp:cellAddr colAddr="1" rowAddr="10"/>
    </hp:tc>
    <hp:tc>
      <hp:subList vertAlign="TOP">
        <hp:p paraPrIDRef="0"><hp:run><hp:t>2026-07-27</hp:t></hp:run></hp:p>
      </hp:subList>
      <hp:cellAddr colAddr="1" rowAddr="2"/>
    </hp:tc>
  </hp:tbl>
</hp:sec>`;
}

describe("훈련계획 HWPX 정렬 정규화", () => {
  it("생성값 문단을 왼쪽 정렬하고 다중행 셀을 상단에 배치한다", async () => {
    const source = new JSZip();
    source.file("mimetype", "application/hwp+zip", { compression: "STORE" });
    source.file("Contents/header.xml", sampleHeader());
    source.file("Contents/section0.xml", sampleSection());
    const input = await source.generateAsync({ type: "uint8array" });

    const normalized = await normalizeTrainingPlanHwpx(input);
    const zip = await JSZip.loadAsync(normalized);
    const header = new DOMParser().parseFromString(
      await zip.file("Contents/header.xml")!.async("string"),
      "application/xml"
    );
    const section = new DOMParser().parseFromString(
      await zip.file("Contents/section0.xml")!.async("string"),
      "application/xml"
    );

    const properties = Array.from(header.getElementsByTagNameNS(HH_NS, "paraPr"));
    for (const property of properties) {
      expect(
        property.getElementsByTagNameNS(HH_NS, "align").item(0)?.getAttribute("horizontal")
      ).toBe("LEFT");
      expect(
        Array.from(property.getElementsByTagNameNS(HC_NS, "intent")).map((node) =>
          node.getAttribute("value")
        )
      ).toEqual(["0"]);
    }

    const cells = Array.from(section.getElementsByTagNameNS(HP_NS, "tc"));
    const contentCell = cells.find(
      (cell) =>
        cell.getElementsByTagNameNS(HP_NS, "cellAddr").item(0)?.getAttribute("rowAddr") ===
        "10"
    )!;
    const contentList = contentCell.getElementsByTagNameNS(HP_NS, "subList").item(0)!;
    const contentParagraphs = Array.from(
      contentList.getElementsByTagNameNS(HP_NS, "p")
    );

    expect(contentList.getAttribute("vertAlign")).toBe("TOP");
    expect(contentParagraphs).toHaveLength(2);
    expect(contentParagraphs.map((paragraph) => paragraph.getAttribute("paraPrIDRef"))).toEqual([
      "0",
      "0",
    ]);
  });

  it("로컬 폴백 HWPX도 본문 기본값을 왼쪽 정렬로 만든다", () => {
    const files = buildHwpxFiles({
      title: "훈련계획",
      sections: [{ heading: "훈련내용", content: "첫째\n둘째" }],
      sources: [],
    });

    expect(files["Contents/header.xml"]).toContain(
      '<hh:align horizontal="LEFT" vertical="BASELINE"/>'
    );
  });

  it("로컬 HWPX 본문 인라인 출처는 제거하고 마지막 근거 자료 및 출처에만 기록한다", () => {
    const inlineRef = "[로프구조 — 경사면 구조 p.44]";
    const files = buildHwpxFiles({
      title: "훈련계획",
      sections: [
        {
          heading: "훈련내용",
          content: `경사면 구조시스템을 결정한다 ${inlineRef}.\n[실습 · 20분] [관련 SOP 적용]`,
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
    });
    const section = files["Contents/section0.xml"];
    const preview = files["Preview/PrvText.txt"];

    expect(section).toContain("경사면 구조시스템을 결정한다.");
    expect(section).toContain("[실습 · 20분] [관련 SOP 적용]");
    expect(section).not.toContain(inlineRef);
    expect(section.match(/로프구조 — 경사면 구조 p\.44/g)).toHaveLength(1);
    expect(preview).not.toContain(inlineRef);
    expect(preview).toMatch(/근거 자료 및 출처\n- 로프구조 — 경사면 구조 p\.44$/);
  });
});
