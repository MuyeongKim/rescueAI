import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  appendDocumentSources,
  documentSourceLines,
  prepareGeneratedDocForExport,
} from "@/lib/document-export";
import { buildDocxBlob } from "@/lib/docx";
import type { GeneratedDoc } from "@/lib/generate";

const SYSTEM_REF = "[로프구조 — 유형별 로프구조시스템 p.44]";
const STRETCHER_REF = "[로프구조 — 경사면 구조 - 들것 보조자 3인 p.47]";
const SOP_REF = "[현장 SOP]";

function sampleDoc(): GeneratedDoc {
  return {
    title: "경사면 구조 훈련계획",
    sections: [
      {
        heading: "훈련목표",
        content:
          `1. 팀 단위로 로프구조시스템을 결정할 수 있다 ${SYSTEM_REF}.\n` +
          `2. 올바른 운용 자세를 시연할 수 있다 ${STRETCHER_REF}, ${SYSTEM_REF}.\n` +
          `[이론교육 · 20분] ${SOP_REF} [관련 SOP 적용] 절차를 확인한다.`,
      },
    ],
    sources: [
      {
        document_id: 1,
        doc: "로프구조 — 유형별 로프구조시스템",
        page: 44,
      },
      {
        document_id: 2,
        doc: "로프구조 — 경사면 구조 - 들것 보조자 3인",
        page: 47,
      },
      { document_id: 3, doc: "현장 SOP", page: null },
      {
        document_id: 1,
        doc: "로프구조 — 유형별 로프구조시스템",
        page: 44,
      },
    ],
    sourceLabels: [SYSTEM_REF, STRETCHER_REF, SOP_REF],
  };
}

describe("최종 문서 출처 정리", () => {
  it("본문 인라인 출처만 제거하고 시간·SOP 적용 표식과 문장부호를 보존한다", () => {
    const prepared = prepareGeneratedDocForExport(sampleDoc());
    const content = prepared.sections[0].content;

    expect(content).toContain("1. 팀 단위로 로프구조시스템을 결정할 수 있다.");
    expect(content).toContain("2. 올바른 운용 자세를 시연할 수 있다.");
    expect(content).toContain("[이론교육 · 20분]");
    expect(content).toContain("[관련 SOP 적용]");
    expect(content).not.toContain(SYSTEM_REF);
    expect(content).not.toContain(STRETCHER_REF);
    expect(content).not.toContain(SOP_REF);
  });

  it("과거 저장본의 페이지형 인용도 제거하고 근거 자료는 중복 없이 끝에 붙인다", () => {
    const lines = documentSourceLines(sampleDoc().sources);
    const body = appendDocumentSources(
      "본문 [허용 목록이 없는 과거 교범 p.99]",
      sampleDoc().sources
    );
    const prepared = prepareGeneratedDocForExport({
      ...sampleDoc(),
      sourceLabels: undefined,
      sections: [{ heading: "훈련내용", content: body }],
    });

    expect(lines).toEqual([
      "로프구조 — 유형별 로프구조시스템 p.44",
      "로프구조 — 경사면 구조 - 들것 보조자 3인 p.47",
      "현장 SOP",
    ]);
    expect(prepared.sections[0].content).not.toContain("[허용 목록이 없는 과거 교범 p.99]");
    expect(body).toMatch(/근거 자료 및 출처\n- 로프구조/);
    expect(body.match(/로프구조 — 유형별 로프구조시스템 p\.44/g)).toHaveLength(1);
  });

  it("DOCX 본문에서는 인라인 라벨을 숨기고 마지막 근거 자료에만 기록한다", async () => {
    const blob = await buildDocxBlob(sampleDoc());
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).toContain("팀 단위로 로프구조시스템을 결정할 수 있다.");
    expect(xml).toContain("근거 자료 및 출처");
    expect(xml).not.toContain(SYSTEM_REF);
    expect(xml).not.toContain(STRETCHER_REF);
    expect(xml.match(/로프구조 — 유형별 로프구조시스템 p\.44/g)).toHaveLength(1);
    expect(xml.match(/현장 SOP/g)).toHaveLength(1);
  });
});
