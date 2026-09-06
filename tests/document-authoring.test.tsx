import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentSectionBody } from "@/components/generate/DocumentSectionBody";
import { DocumentSectionEvidence } from "@/components/generate/DocumentSectionEvidence";
import { buildDocxBlob } from "@/lib/docx";
import { normalizeDocumentText } from "@/lib/document-text";
import { documentSectionBlocks, evaluationTableRows, replaceDocumentSpan, replaceEvaluationCell, trainingTableRows } from "@/lib/document-structure";
import { docToText, hydrateMaterial } from "@/lib/generate-material";
import { prepareGeneratedDocForExport } from "@/lib/document-export";
import { normalizeHwpxCellText } from "@/lib/hwpx-format";
import { buildHwpxFiles } from "@/lib/hwpx";
import { inspectGeneratedPlan, type GeneratedDoc, type SavedMaterial } from "@/lib/generate";

const training = {
  heading: "훈련내용",
  content: "[관련 SOP 적용] 근거 범위 확인\n\n[교관시범 · 20분]\n교관 행동: 원문 확인\n대원 행동: 관찰\n\n[반복실습 · 40분]\n1) 장비 확인 → 이상 보고\n추가 조건 보존",
};
const evaluation = {
  heading: "훈련평가",
  content: "평가 전 교관 확인\n- 장비 점검 — 순서 관찰 / 누락 없이 수행 / 누락 시 재시연\n수치 기준은 원문에서 확인\n- 이상 보고 — 보고 동작 확인 / 필요한 사항 전달 / 다시 보고",
};

describe("문서 줄바꿈과 메타데이터", () => {
  it("한국어 항목의 이중 이스케이프만 복원하고 코드·경로·URL을 보존한다", () => {
    expect(normalizeDocumentText("첫 번째\\n두 번째\\n\\n[교관시범 · 20분]\\n1) 확인")).toBe("첫 번째\n두 번째\n\n[교관시범 · 20분]\n1) 확인");
    const protectedText = "`예시\\n문자` C:\\new\\내부 https://example.test/a\\n문서\n```text\n예시\\n문자\n```";
    expect(normalizeDocumentText(protectedText)).toBe(protectedText);
    expect(normalizeDocumentText("first\\nsecond")).toBe("first\\nsecond");
  });

  it("과거 저장본·화면·HWPX·복사의 줄바꿈이 일치하며 원본을 변경하지 않는다", () => {
    const content = "첫 번째 항목\\n두 번째 항목";
    const doc: GeneratedDoc = { title: "확인용", sections: [{ heading: "훈련목표", content }], sources: [] };
    expect(prepareGeneratedDocForExport(doc).sections[0].content).toBe("첫 번째 항목\n두 번째 항목");
    expect(normalizeHwpxCellText(content)).toBe("첫 번째 항목\n두 번째 항목");
    expect(docToText(doc)).toContain("첫 번째 항목\n두 번째 항목");
    expect(hydrateMaterial({ kind: "plan", title: doc.title, content: { sections: doc.sections } } as SavedMaterial).doc?.sections[0].content).toBe("첫 번째 항목\n두 번째 항목");
    expect(doc.sections[0].content).toBe(content);
  });

  it("현재 날짜·장소·대상을 DOCX와 복사에 동일하게 넣고 실제 표를 출력한다", async () => {
    const doc: GeneratedDoc = { title: "훈련 계획", sections: [training, evaluation], sources: [] };
    const metadata = { date: "2026-09-20", place: "제2 훈련장", audience: "신임 대원", duration: "1시간" };
    const copied = docToText(doc, metadata);
    const blob = await buildDocxBlob(doc, metadata);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    for (const expected of ["훈련 일자: 2026-09-20", "훈련 장소: 제2 훈련장", "교육 대상: 신임 대원", "교육 시간: 1시간"]) {
      expect(copied).toContain(expected);
      expect(xml).toContain(expected);
    }
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("교육 진행 · 행동 · 확인");
    expect(xml).toContain("관찰 가능한 수행 기준");
    expect(xml).toContain("[관련 SOP 적용] 근거 범위 확인");
    expect(xml).toContain("수치 기준은 원문에서 확인");
  });
});

describe("문서 시간표·평가표 호환", () => {
  it("선택한 시간·내용만 교체하여 SOP와 나머지 섹션 문장을 보존한다", () => {
    const rows = trainingTableRows(training);
    expect(rows.map((row) => [row.name, row.minutes])).toEqual([["교관시범", "20"], ["반복실습", "40"]]);
    expect(replaceDocumentSpan(training.content, rows[0].minutesSpan, "15")).toBe(training.content.replace("20분", "15분"));
    expect(replaceDocumentSpan(training.content, rows[1].bodySpan, "수정한 대원 행동")).toBe(training.content.replace("1) 장비 확인 → 이상 보고\n추가 조건 보존", "수정한 대원 행동"));
    const lesson = { heading: "도입", content: "[시간: 5분]\n시작 질문" };
    expect(trainingTableRows(lesson)[0]).toMatchObject({ name: "도입", minutes: "5", body: "시작 질문" });
  });

  it("평가표 네 칸을 구분하고 구분되지 않는 문장은 출력에서 보존한다", () => {
    const rows = evaluationTableRows(evaluation);
    expect(rows[0].cells).toEqual(["장비 점검", "순서 관찰", "누락 없이 수행", "누락 시 재시연"]);
    expect(replaceDocumentSpan(evaluation.content, rows[0].spans[2], "누락 확인 후 통과")).toBe(evaluation.content.replace("누락 없이 수행", "누락 확인 후 통과"));
    expect(evaluationTableRows({ ...evaluation, content: replaceDocumentSpan(evaluation.content, rows[0].spans[0], "") })).toHaveLength(2);
    const blocks = documentSectionBlocks(evaluation);
    expect(blocks.filter((block) => block.type === "text").map((block) => block.text).join("")).toContain("수치 기준은 원문에서 확인");
    expect(evaluationTableRows({ ...evaluation, content: "자유로운 평가 문단은 그대로 유지" })).toEqual([]);
  });

  it("모바일에서 스크롤 가능한 표와 접근 가능한 편집 이름을 제공한다", () => {
    const read = renderToStaticMarkup(<DocumentSectionBody section={training} index={1} editing={false} disabled={false} onChange={() => {}} />);
    expect(read).toContain('role="region"');
    expect(read).toContain('tabindex="0"');
    expect(read).toContain('scope="col"');
    const edit = renderToStaticMarkup(<DocumentSectionBody section={training} index={1} editing disabled onChange={() => {}} />);
    expect(edit).toContain("교관시범 배정 시간 분");
    expect(edit).toContain("전체 본문 편집");
    expect(edit).toContain("disabled");
  });

  it("평가항목명은 한 줄, 긴 설명 세 칸은 높이가 확보된 여러 줄 입력으로 제공한다", () => {
    const longText = "교관은 대원의 장비 점검 순서를 관찰하고 동료 확인 및 이상 발견 시 보고 여부를 확인한다. ".repeat(4);
    const row = evaluationTableRows(evaluation)[0];
    const section = { ...evaluation, content: replaceEvaluationCell(evaluation.content, row, 1, longText) };
    const html = renderToStaticMarkup(<DocumentSectionBody section={section} index={4} editing disabled={false} onChange={() => {}} />);
    expect(html.match(/<input\b/g)).toHaveLength(2);
    expect(html.match(/rows="3"/g)).toHaveLength(6);
    expect(html.match(/min-h-24 text-base leading-relaxed/g)).toHaveLength(6);
    expect(html).toContain(longText.trim());
  });

  it("평가 셀의 Enter·빈 줄·따옴표·구분자를 왕복하고 다른 문단과 평가 행을 보존한다", () => {
    const values = ["순서를 관찰한다.\n\n동료가 \"확인\"한다.\n", "통과 판단\n누락 없이 수행 / 보고한다.", "피드백 후 재시연\n다시 확인한다."];
    let content = evaluation.content;
    for (let index = 1; index <= 3; index++) {
      content = replaceEvaluationCell(content, evaluationTableRows({ ...evaluation, content })[0], index, values[index - 1]);
    }
    const rows = evaluationTableRows({ ...evaluation, content });
    expect(rows).toHaveLength(2);
    expect(rows[0].cells).toEqual(["장비 점검", ...values]);
    expect(rows[1].cells).toEqual(evaluationTableRows(evaluation)[1].cells);
    expect(content).toContain("평가 전 교관 확인\n");
    expect(content).toContain("\n수치 기준은 원문에서 확인\n");
    const editedSecond = replaceEvaluationCell(content, rows[1], 2, "통과 기준 확인\n보고 내용 확인");
    expect(evaluationTableRows({ ...evaluation, content: editedSecond })[1].cells[2]).toBe("통과 기준 확인\n보고 내용 확인");
    expect(documentSectionBlocks({ ...evaluation, content }).find((block) => block.type === "table")).toMatchObject({ rows: [["장비 점검", ...values]] });
    const quality = inspectGeneratedPlan({ title: "확인", sections: [{ ...evaluation, content }] }, "1시간");
    expect(quality.issues.some((issue) => issue.code === "missing_evaluation")).toBe(false);
  });

  it("복사·로컬 HWPX는 저장용 셀 인용만 해제하고 실제 따옴표와 줄바꿈을 보존한다", () => {
    const values = ['첫 줄\n\n"확인"이라고 보고\n', '"통과"', "재시연 / 재평가"];
    let content = evaluation.content;
    for (let index = 1; index <= 3; index++) {
      content = replaceEvaluationCell(content, evaluationTableRows({ ...evaluation, content })[0], index, values[index - 1]);
    }
    const doc: GeneratedDoc = { title: "평가표", sections: [{ ...evaluation, content }], sources: [] };
    const original = structuredClone(doc);
    const expected = `- 장비 점검 — ${values.join(" / ")}`;
    expect(docToText(doc)).toContain(expected);
    const files = buildHwpxFiles(doc);
    expect(files["Preview/PrvText.txt"]).toContain(expected);
    expect(files["Contents/section0.xml"]).toContain('&quot;확인&quot;이라고 보고');
    expect(files["Contents/section0.xml"]).toContain('&quot;통과&quot;');
    expect(files["Contents/section0.xml"]).not.toContain('&quot;&quot;');
    expect(files["Preview/PrvText.txt"]).toContain("수치 기준은 원문에서 확인");
    expect(doc).toEqual(original);
    expect(prepareGeneratedDocForExport(doc).sections[0].content).toBe(content);
    expect(evaluationTableRows(prepareGeneratedDocForExport(doc).sections[0])[0].cells).toEqual(["장비 점검", ...values]);
  });

  it("기존 한 줄 평가 셀의 자연스러운 인용과 이웃 셀 편집 후 따옴표를 보존한다", () => {
    const section = { heading: "훈련평가", content: '- 보고 — "확인" / "통과" / "재수행"' };
    const rows = evaluationTableRows(section);
    expect(rows[0].cells).toEqual(["보고", '"확인"', '"통과"', '"재수행"']);
    const doc: GeneratedDoc = { title: "기존 평가", sections: [section], sources: [] };
    expect(docToText(doc)).toContain(section.content);
    expect(buildHwpxFiles(doc)["Preview/PrvText.txt"]).toContain(section.content);
    const edited = { ...section, content: replaceEvaluationCell(section.content, rows[0], 2, '"판단"') };
    expect(evaluationTableRows(edited)[0].cells).toEqual(["보고", '"확인"', '"판단"', '"재수행"']);
    expect(docToText({ ...doc, sections: [edited] })).toContain('- 보고 — "확인" / "판단" / "재수행"');
  });

  it("근거 후보를 사실성 검증으로 표현하지 않고 정확한 원문 페이지에 연결한다", () => {
    const html = renderToStaticMarkup(<DocumentSectionEvidence heading="안전관리" onLoad={() => {}} state={{ status: "ready", items: [{ source: { document_id: 54, doc: "구급 교재", page: 270 }, excerpt: "서버가 직접 읽은 원문 구절", matchKind: "text-overlap" }] }} />);
    expect(html).toContain("문장 전체의 사실성 판정은 아니므로");
    expect(html).toContain('/docs/54?page=270');
    expect(html).toContain("서버가 직접 읽은 원문 구절");
  });
});
