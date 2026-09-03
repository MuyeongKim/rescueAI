import {
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import JSZip from "jszip";

import { hwpxParagraphs, normalizeHwpxCellText } from "@/lib/hwpx-format";

const HH_NS = "http://www.hancom.co.kr/hwpml/2011/head";
const HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph";
const HC_NS = "http://www.hancom.co.kr/hwpml/2011/core";

const VALUE_ROWS = new Set(["2", "3", "4", "6", "7", "8", "9", "10", "11", "12", "13"]);
const MULTILINE_ROWS = new Set(["6", "10", "11", "12", "13"]);

function parseXml(xml: string, path: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (!document.documentElement) {
    throw new Error(`${path} XML을 읽을 수 없습니다.`);
  }
  return document;
}

type GeneratedParagraphStyles = {
  body: string;
  bullet: string;
  label: string;
};

function setMetric(property: XmlElement, name: string, value: number) {
  const nodes = Array.from(property.getElementsByTagNameNS(HC_NS, name));
  for (const node of nodes) node.setAttribute("value", String(value));
}

function configureParagraphProperty(
  property: XmlElement,
  opts: {
    intent: number;
    left: number;
    prev: number;
    next: number;
    keepWithNext?: boolean;
  }
) {
  const align = property.getElementsByTagNameNS(HH_NS, "align").item(0);
  align?.setAttribute("horizontal", "LEFT");
  const breakSetting = property
    .getElementsByTagNameNS(HH_NS, "breakSetting")
    .item(0);
  breakSetting?.setAttribute("keepWithNext", opts.keepWithNext ? "1" : "0");
  setMetric(property, "intent", opts.intent);
  setMetric(property, "left", opts.left);
  setMetric(property, "prev", opts.prev);
  setMetric(property, "next", opts.next);
}

function normalizeParagraphProperties(headerXml: string): {
  xml: string;
  styles: GeneratedParagraphStyles;
} {
  const document = parseXml(headerXml, "Contents/header.xml");
  const properties = Array.from(document.getElementsByTagNameNS(HH_NS, "paraPr"));
  const body = properties.find((property) => property.getAttribute("id") === "0");
  const legacyGenerated =
    properties.find((property) => property.getAttribute("id") === "48") ?? body;

  if (!body || !legacyGenerated) {
    throw new Error("훈련계획 HWPX 문단 서식을 찾을 수 없습니다.");
  }

  // 기존 양식의 기본값은 이전 버전과 동일하게 왼쪽 정렬만 보정한다. 새 간격·들여쓰기는
  // 생성 셀 전용 복제 서식에 적용해 날짜·장소 같은 다른 표 셀 높이에 영향을 주지 않는다.
  configureParagraphProperty(body, {
    intent: 0,
    left: 0,
    prev: 0,
    next: 0,
  });
  configureParagraphProperty(legacyGenerated, {
    intent: 0,
    left: 0,
    prev: 0,
    next: 0,
  });

  const usedIds = properties
    .map((property) => Number(property.getAttribute("id")))
    .filter(Number.isFinite);
  const firstGeneratedId = (usedIds.length > 0 ? Math.max(...usedIds) : 0) + 1;
  const bodyId = String(firstGeneratedId);
  const bulletId = String(firstGeneratedId + 1);
  const labelId = String(firstGeneratedId + 2);
  const generatedBody = body.cloneNode(true) as unknown as XmlElement;
  generatedBody.setAttribute("id", bodyId);
  configureParagraphProperty(generatedBody, {
    intent: 0,
    left: 0,
    prev: 0,
    next: 250,
  });
  const bullet = body.cloneNode(true) as unknown as XmlElement;
  bullet.setAttribute("id", bulletId);
  configureParagraphProperty(bullet, {
    intent: -800,
    left: 800,
    prev: 0,
    next: 120,
  });
  const label = body.cloneNode(true) as unknown as XmlElement;
  label.setAttribute("id", labelId);
  configureParagraphProperty(label, {
    intent: 0,
    left: 0,
    prev: 500,
    next: 180,
    keepWithNext: true,
  });

  const container = document
    .getElementsByTagNameNS(HH_NS, "paraProperties")
    .item(0);
  if (container) {
    container.appendChild(generatedBody);
    container.appendChild(bullet);
    container.appendChild(label);
    container.setAttribute("itemCnt", String(properties.length + 3));
  }

  return {
    xml: new XMLSerializer().serializeToString(document),
    styles: {
      body: container ? bodyId : body.getAttribute("id") ?? "0",
      bullet: container ? bulletId : legacyGenerated.getAttribute("id") ?? "48",
      label: container ? labelId : body.getAttribute("id") ?? "0",
    },
  };
}

function paragraphText(paragraph: XmlElement): string {
  return Array.from(paragraph.getElementsByTagNameNS(HP_NS, "t"))
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function splitEmbeddedParagraphs(paragraph: XmlElement): XmlElement[] {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(HP_NS, "t"));
  const original = textNodes.map((node) => node.textContent ?? "").join("");
  const normalized = normalizeHwpxCellText(original);
  const lines = normalized.split("\n");
  if (lines.length <= 1) {
    if (textNodes[0] && normalized !== original) {
      textNodes[0].textContent = normalized;
      for (const node of textNodes.slice(1)) node.textContent = "";
    }
    return [paragraph];
  }

  const parent = paragraph.parentNode;
  if (!parent) return [paragraph];
  const replacements = lines.map((line) => {
    const clone = paragraph.cloneNode(true) as unknown as XmlElement;
    const cloneTexts = Array.from(clone.getElementsByTagNameNS(HP_NS, "t"));
    if (cloneTexts[0]) cloneTexts[0].textContent = line;
    for (const node of cloneTexts.slice(1)) node.textContent = "";
    parent.insertBefore(clone, paragraph);
    return clone;
  });
  parent.removeChild(paragraph);
  return replacements;
}

function normalizeGeneratedCells(
  sectionXml: string,
  styles: GeneratedParagraphStyles
): string {
  const document = parseXml(sectionXml, "Contents/section0.xml");
  const cells = Array.from(document.getElementsByTagNameNS(HP_NS, "tc"));

  for (const cell of cells) {
    const address = cell.getElementsByTagNameNS(HP_NS, "cellAddr").item(0);
    const row = address?.getAttribute("rowAddr") ?? "";
    if (
      !address ||
      address.getAttribute("colAddr") !== "1" ||
      !VALUE_ROWS.has(row)
    ) {
      continue;
    }

    const subList = cell.getElementsByTagNameNS(HP_NS, "subList").item(0);
    if (!subList) continue;

    subList.setAttribute("vertAlign", MULTILINE_ROWS.has(row) ? "TOP" : "CENTER");

    const paragraphs = Array.from(subList.getElementsByTagNameNS(HP_NS, "p")).flatMap(
      splitEmbeddedParagraphs
    );
    while (
      paragraphs.length > 1 &&
      paragraphText(paragraphs[paragraphs.length - 1]) === ""
    ) {
      const trailing = paragraphs.pop();
      trailing?.parentNode?.removeChild(trailing);
    }

    if (!MULTILINE_ROWS.has(row)) continue;

    for (const paragraph of paragraphs) {
      const item = hwpxParagraphs(paragraphText(paragraph))[0];
      const style =
        item?.kind === "bullet"
          ? styles.bullet
          : item?.kind === "label"
            ? styles.label
            : styles.body;
      paragraph.setAttribute("paraPrIDRef", style);
    }
  }

  return new XMLSerializer().serializeToString(document);
}

export async function normalizeTrainingPlanHwpx(
  input: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input);
  const headerFile = zip.file("Contents/header.xml");
  const sectionFile = zip.file("Contents/section0.xml");
  const mimetypeFile = zip.file("mimetype");
  if (!headerFile || !sectionFile || !mimetypeFile) {
    throw new Error("훈련계획 HWPX 필수 파일이 없습니다.");
  }

  const [headerXml, sectionXml, mimetype] = await Promise.all([
    headerFile.async("string"),
    sectionFile.async("string"),
    mimetypeFile.async("string"),
  ]);

  zip.file("mimetype", mimetype, { compression: "STORE" });
  const normalizedHeader = normalizeParagraphProperties(headerXml);
  zip.file("Contents/header.xml", normalizedHeader.xml);
  zip.file(
    "Contents/section0.xml",
    normalizeGeneratedCells(sectionXml, normalizedHeader.styles)
  );

  return zip.generateAsync({
    type: "uint8array",
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
  });
}
