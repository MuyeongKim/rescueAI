import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

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

function normalizeParagraphProperty(headerXml: string): string {
  const document = parseXml(headerXml, "Contents/header.xml");
  const properties = Array.from(document.getElementsByTagNameNS(HH_NS, "paraPr"));

  for (const property of properties) {
    const id = property.getAttribute("id");
    if (id !== "0" && id !== "48") continue;

    const align = property.getElementsByTagNameNS(HH_NS, "align").item(0);
    align?.setAttribute("horizontal", "LEFT");

    const intents = Array.from(property.getElementsByTagNameNS(HC_NS, "intent"));
    for (const intent of intents) intent.setAttribute("value", "0");
  }

  return new XMLSerializer().serializeToString(document);
}

function paragraphText(paragraph: Element): string {
  return Array.from(paragraph.getElementsByTagNameNS(HP_NS, "t"))
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function normalizeGeneratedCells(sectionXml: string): string {
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

    const paragraphs = Array.from(subList.getElementsByTagNameNS(HP_NS, "p"));
    while (
      paragraphs.length > 1 &&
      paragraphText(paragraphs[paragraphs.length - 1] as unknown as Element) === ""
    ) {
      const trailing = paragraphs.pop();
      trailing?.parentNode?.removeChild(trailing);
    }

    for (const paragraph of paragraphs) {
      paragraph.setAttribute("paraPrIDRef", "0");
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
  zip.file("Contents/header.xml", normalizeParagraphProperty(headerXml));
  zip.file("Contents/section0.xml", normalizeGeneratedCells(sectionXml));

  return zip.generateAsync({
    type: "uint8array",
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
  });
}
