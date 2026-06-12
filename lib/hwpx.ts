// 생성 문서(GeneratedDoc) → 한글(.hwpx) 변환. 클라이언트에서 동적 import로만 사용.
// HWPX = ZIP + OWPML(XML). 한컴 문서(한글 2014+)의 실제 파일 구조를 기준으로
// 최소 골격(mimetype/version/container/content.hpf/header/section0/settings)을 직접 조립한다.
import JSZip from "jszip";
import type { GeneratedDoc } from "@/lib/generate";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

// OWPML 네임스페이스 묶음 (header/section 공통)
const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── charPr 4종: 0 본문 10pt · 1 제목 16pt 굵게 · 2 소제목 12pt 굵게 · 3 보조 9pt 회색 ──
function charPr(id: number, height: number, opts?: { bold?: boolean; color?: string }) {
  return (
    `<hh:charPr id="${id}" height="${height}" textColor="${opts?.color ?? "#000000"}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
    '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
    '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
    '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
    '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
    '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
    (opts?.bold ? "<hh:bold/>" : "") +
    '<hh:underline type="NONE" shape="SOLID" color="#000000"/>' +
    '<hh:strikeout shape="NONE" color="#000000"/>' +
    '<hh:outline type="NONE"/>' +
    '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
    "</hh:charPr>"
  );
}

// ── paraPr 2종: 0 양쪽정렬 · 1 가운데정렬 ──
function paraPr(id: number, align: "JUSTIFY" | "CENTER") {
  const margin =
    "<hh:margin>" +
    '<hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/>' +
    "</hh:margin>" +
    '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>';
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">` +
    `<hh:align horizontal="${align}" vertical="BASELINE"/>` +
    '<hh:heading type="NONE" idRef="0" level="0"/>' +
    '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>' +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch>` +
    '<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>' +
    "</hh:paraPr>"
  );
}

function borderFill(id: number) {
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
    '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    "</hh:borderFill>"
  );
}

function buildHeaderXml(): string {
  const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
  const fontfaces =
    `<hh:fontfaces itemCnt="${langs.length}">` +
    langs
      .map(
        (lang) =>
          `<hh:fontface lang="${lang}" fontCnt="1">` +
          '<hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">' +
          '<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>' +
          "</hh:font></hh:fontface>"
      )
      .join("") +
    "</hh:fontfaces>";

  return (
    XML_DECL +
    `<hh:head ${NS} version="1.4" secCnt="1">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    "<hh:refList>" +
    fontfaces +
    `<hh:borderFills itemCnt="2">${borderFill(1)}${borderFill(2)}</hh:borderFills>` +
    `<hh:charProperties itemCnt="4">${charPr(0, 1000)}${charPr(1, 1600, { bold: true })}${charPr(2, 1200, { bold: true })}${charPr(3, 900, { color: "#555555" })}</hh:charProperties>` +
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
    `<hh:paraProperties itemCnt="2">${paraPr(0, "JUSTIFY")}${paraPr(1, "CENTER")}</hh:paraProperties>` +
    '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
    "</hh:refList>" +
    "</hh:head>"
  );
}

// A4 세로(59528×84188 HWPUNIT), 표준 여백 — 실제 한컴 문서의 secPr 골격을 따른다.
const SEC_PR =
  '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" textVerticalWidthHead="0" masterPageCnt="0">' +
  '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
  '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
  '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
  '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
  '<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">' +
  '<hp:margin header="4251" footer="2834" gutter="0" left="5669" right="5669" top="2834" bottom="2834"/>' +
  "</hp:pagePr>" +
  '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>' +
  '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>' +
  '<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
  '<hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
  '<hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
  "</hp:secPr>";

type Para = {
  text: string;
  charPrId: number; // header.xml charProperties 참조
  paraPrId: number; // header.xml paraProperties 참조
  withSecPr?: boolean;
};

let paraSeq = 0;

function paragraph(p: Para): string {
  paraSeq += 1;
  const h = p.charPrId === 1 ? 1600 : p.charPrId === 2 ? 1200 : p.charPrId === 3 ? 900 : 1000;
  const lineseg = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${h}" textheight="${h}" baseline="${Math.round(h * 0.85)}" spacing="${Math.round(h * 0.6)}" horzpos="0" horzsize="48190" flags="393216"/></hp:linesegarray>`;
  return (
    `<hp:p id="${paraSeq}" paraPrIDRef="${p.paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
    `<hp:run charPrIDRef="${p.charPrId}">${p.withSecPr ? SEC_PR : ""}<hp:t>${esc(p.text)}</hp:t></hp:run>` +
    lineseg +
    "</hp:p>"
  );
}

function buildSectionXml(doc: GeneratedDoc): string {
  paraSeq = 0;
  const paras: string[] = [];
  // 제목 (첫 문단이 secPr을 가진다)
  paras.push(paragraph({ text: doc.title, charPrId: 1, paraPrId: 1, withSecPr: true }));
  paras.push(
    paragraph({
      text: "전북특별자치도 소방본부 — AI 생성 초안 (시행 전 검토 필요)",
      charPrId: 3,
      paraPrId: 1,
    })
  );
  paras.push(paragraph({ text: "", charPrId: 0, paraPrId: 0 }));

  for (const section of doc.sections) {
    paras.push(paragraph({ text: section.heading, charPrId: 2, paraPrId: 0 }));
    for (const line of section.content.split("\n")) {
      paras.push(paragraph({ text: line, charPrId: 0, paraPrId: 0 }));
    }
    paras.push(paragraph({ text: "", charPrId: 0, paraPrId: 0 }));
  }

  if (doc.sources.length > 0) {
    paras.push(paragraph({ text: "근거 자료", charPrId: 2, paraPrId: 0 }));
    for (const s of doc.sources) {
      paras.push(
        paragraph({
          text: `- ${s.doc}${s.page != null ? ` p.${s.page}` : ""}`,
          charPrId: 0,
          paraPrId: 0,
        })
      );
    }
  }

  return XML_DECL + `<hs:sec ${NS}>` + paras.join("") + "</hs:sec>";
}

function buildContentHpf(title: string): string {
  return (
    XML_DECL +
    `<opf:package ${NS} version="" unique-identifier="" id="">` +
    "<opf:metadata>" +
    `<opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language>` +
    '<opf:meta name="creator" content="text">전북소방 구조 교육훈련 플랫폼</opf:meta>' +
    "</opf:metadata>" +
    "<opf:manifest>" +
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>' +
    "</opf:manifest>" +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>' +
    "</opf:package>"
  );
}

const CONTAINER_XML =
  XML_DECL +
  '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">' +
  "<ocf:rootfiles>" +
  '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
  '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
  '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>' +
  "</ocf:rootfiles></ocf:container>";

const CONTAINER_RDF =
  XML_DECL +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
  '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
  '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
  '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
  '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description>' +
  "</rdf:RDF>";

const MANIFEST_XML =
  XML_DECL +
  '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';

const VERSION_XML =
  XML_DECL +
  '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="JBFire Rescue Platform" appVersion="1.0"/>';

const SETTINGS_XML =
  XML_DECL +
  '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">' +
  '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';

function buildPreviewText(doc: GeneratedDoc): string {
  const body = doc.sections.map((s) => `${s.heading}\n${s.content}`).join("\n\n");
  return `${doc.title}\n\n${body}`;
}

// HWPX 패키지 파일 맵 (테스트에서도 재사용)
export function buildHwpxFiles(doc: GeneratedDoc): Record<string, string> {
  return {
    mimetype: "application/hwp+zip",
    "version.xml": VERSION_XML,
    "settings.xml": SETTINGS_XML,
    "META-INF/container.xml": CONTAINER_XML,
    "META-INF/container.rdf": CONTAINER_RDF,
    "META-INF/manifest.xml": MANIFEST_XML,
    "Contents/content.hpf": buildContentHpf(doc.title),
    "Contents/header.xml": buildHeaderXml(),
    "Contents/section0.xml": buildSectionXml(doc),
    "Preview/PrvText.txt": buildPreviewText(doc),
  };
}

export async function buildHwpxBlob(doc: GeneratedDoc): Promise<Blob> {
  const zip = new JSZip();
  const files = buildHwpxFiles(doc);
  // mimetype 은 압축 없이(STORE) 첫 항목으로
  zip.file("mimetype", files.mimetype, { compression: "STORE" });
  for (const [path, content] of Object.entries(files)) {
    if (path === "mimetype") continue;
    zip.file(path, content);
  }
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
  });
}
