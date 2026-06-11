// 생성 문서(GeneratedDoc) → 워드(.docx) 변환. 클라이언트에서 동적 import로만 사용.
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { GeneratedDoc } from "@/lib/generate";

export async function buildDocxBlob(doc: GeneratedDoc): Promise<Blob> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: doc.title })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "전북특별자치도 소방본부 — AI 생성 초안 (시행 전 검토 필요)",
          size: 18,
          color: "888888",
        }),
      ],
      spacing: { after: 400 },
    }),
  ];

  for (const section of doc.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.heading })],
        spacing: { before: 300, after: 120 },
      })
    );
    for (const line of section.content.split("\n")) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 22 })],
          spacing: { after: 80 },
        })
      );
    }
  }

  if (doc.sources.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "근거 자료" })],
        spacing: { before: 300, after: 120 },
      })
    );
    for (const s of doc.sources) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              text: `${s.doc}${s.page != null ? ` p.${s.page}` : ""}`,
              size: 22,
            }),
          ],
        })
      );
    }
  }

  const file = new Document({ sections: [{ children }] });
  return Packer.toBlob(file);
}
