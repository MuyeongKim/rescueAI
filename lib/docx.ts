// 생성 문서(GeneratedDoc) → 워드(.docx) 변환. 클라이언트에서 동적 import로만 사용.
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
  TableLayoutType,
} from "docx";
import type { GeneratedDoc } from "@/lib/generate";
import {
  DOCUMENT_SOURCE_SECTION_TITLE,
  documentSourceLines,
  prepareGeneratedDocForExport,
  documentMetadataLines,
  type DocumentMetadata,
} from "@/lib/document-export";
import { documentSectionBlocks } from "@/lib/document-structure";

// 기본 테마 글꼴에 한글 글리프가 없는 LibreOffice 환경에서도 본문이 사라지지 않도록
// 동아시아 글꼴을 명시한다. Word는 해당 글꼴이 없을 때 설치된 한글 글꼴로 대체한다.
const DOCX_FONT = {
  ascii: "Nanum Gothic",
  hAnsi: "Nanum Gothic",
  eastAsia: "Nanum Gothic",
  cs: "Nanum Gothic",
} as const;

export async function buildDocxBlob(doc: GeneratedDoc, metadata?: DocumentMetadata): Promise<Blob> {
  const exportDoc = prepareGeneratedDocForExport(doc);
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: exportDoc.title, font: DOCX_FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "전북특별자치도 소방본부 — AI 생성 초안 (시행 전 검토 필요)",
          size: 18,
          color: "888888",
          font: DOCX_FONT,
        }),
      ],
      spacing: { after: 400 },
    }),
  ];
  for (const line of documentMetadataLines(metadata)) {
    children.push(new Paragraph({ children: [new TextRun({ text: line, size: 22, font: DOCX_FONT })], spacing: { after: 80 } }));
  }

  for (const section of exportDoc.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        keepNext: true,
        children: [new TextRun({ text: section.heading, font: DOCX_FONT })],
        spacing: { before: 300, after: 120 },
      })
    );
    for (const block of documentSectionBlocks(section)) {
      if (block.type === "table") {
        const widths = block.headers.length === 3 ? [1735, 1157, 6746] : [1735, 3084, 1928, 2891];
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          layout: TableLayoutType.FIXED,
          columnWidths: widths,
          rows: [block.headers, ...block.rows].map((row, index) => new TableRow({
            tableHeader: index === 0,
            children: row.map((cell, cellIndex) => new TableCell({
              width: { size: widths[cellIndex], type: WidthType.DXA },
              shading: index === 0 ? { fill: "EDEFF2" } : undefined,
              children: cell.split("\n").map((line) => new Paragraph({
                children: [new TextRun({ text: line, size: 21, bold: index === 0, font: DOCX_FONT })],
                spacing: { after: 60 },
              })),
            })),
          })),
        }));
        children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
      } else for (const line of block.text.split("\n")) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, size: 22, font: DOCX_FONT })],
          spacing: { after: 80 },
        }));
      }
    }
  }

  const sourceLines = documentSourceLines(exportDoc.sources);
  if (sourceLines.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({ text: DOCUMENT_SOURCE_SECTION_TITLE, font: DOCX_FONT }),
        ],
        spacing: { before: 300, after: 120 },
      })
    );
    for (const source of sourceLines) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              text: source,
              size: 22,
              font: DOCX_FONT,
            }),
          ],
        })
      );
    }
  }

  const file = new Document({ sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    children,
  }] });
  return Packer.toBlob(file);
}
