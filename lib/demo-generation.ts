import { demoDocuments } from "@/lib/demo";
import { durationMinutes, generationQualityMessages, inspectCurrentGenerationQuality, resolveSlideDeckMode, slideCountRangeFor,
  type GeneratedDoc, type GeneratedSlide, type GeneratedSlideDeck } from "@/lib/generate";
import type { ValidatedGenerateRequest } from "@/lib/generation-request";
import { SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";

const DEMO_WARNING = "화면 체험용 예시입니다. 실제 RAG 검색이나 기술 사실 검증을 수행하지 않았습니다.";
const safety = "교관은 실습 전 위험 구역과 보호장비 상태를 점검한다. 대원은 이상 징후가 보이면 즉시 훈련을 중단하고 교관에게 보고한다. 원인이 해소되고 안전담당자가 재개를 확인한 뒤에만 다음 단계로 이동한다. 동료의 결과를 관찰하며 미확인 상태로 실습을 이어가지 않는다.";
const evaluation = "교관은 체크리스트로 대원이 제시된 확인 항목을 누락 없이 수행하는지 관찰한다. 모든 필수 항목을 정확히 설명하고 수행하면 통과로 기록한다. 누락 항목은 강평에서 확인하고 다시 시연한 뒤 기준 충족 여부를 평가한다. 대원은 피드백 내용을 말로 정리하고 다음 실습에 반영한다.";
const actions = "대원 행동절차:\n1) 제시된 교육 자료를 읽고 확인할 항목을 말한다.\n2) 교관의 시범을 관찰하고 정상 여부의 확인 지점을 기록한다.\n3) 확인 결과를 교관에게 보고하고 동료의 피드백을 확인한다.\n이상이나 누락 시 수행을 중단하고 교관에게 보고한 뒤 교정하여 다시 점검한다. 이는 화면 체험을 위한 교육 진행 예시이며 실제 장비의 기술 절차를 뜻하지 않는다.";
function enough(value: string, minimum: number): string {
  const supplement = " 이 예시는 편집·출처 열기·파일 다운로드 흐름을 확인하기 위한 샘플이다. 실제 교육에서는 담당자가 최신 원문과 현장 조건에 맞는 내용을 검토하여 교체한다.";
  while (value.length < minimum) value += supplement;
  return value;
}
/** 데모도 실제 편집기의 구조·시간·출처 계약을 지키되 실제 근거 검증으로 표시하지 않는다. */
export function buildDemoGeneration(request: ValidatedGenerateRequest) {
  const sourceDoc = demoDocuments?.find((doc) => doc.category === request.category);
  const source = { document_id: sourceDoc?.id ?? 0, doc: sourceDoc?.title ?? "데모 참고 자료", page: 1 };
  const sourceLabels = [`[${source.doc} p.1]`];
  const common = { sources: [source], sourceLabels, sopEvidence: { status: "not_found" as const, sourceLabels: [] } };
  const title = `화면 체험 예시 — ${request.topic}`;
  const ratio = durationMinutes(request.duration) / 60;
  let result: GeneratedDoc | GeneratedSlideDeck;
  if (request.type === "slides") {
    const titles = ["학습 목표를 먼저 확인합니다", "참고 자료의 범위를 확인합니다", "확인할 항목을 함께 정합니다", "교관 시범의 확인 지점을 봅니다", "대원의 설명을 서로 확인합니다", "확인 결과를 기록합니다", "사례에 맞는 판단을 연습합니다", "누락 항목을 다시 확인합니다", "안전과 중단 기준을 먼저 확인합니다", "체크리스트로 수행 결과를 평가합니다", "피드백 내용을 다음 실습에 반영합니다", "교육 내용을 정리하고 마칩니다"];
    const count = slideCountRangeFor(request.duration)[0];
    const slides: GeneratedSlide[] = Array.from({ length: count }, (_, index) => ({
      title: index < titles.length ? titles[index] : `추가 실습 ${index - titles.length + 1}의 확인 결과를 나눕니다`,
      bullets: index === count - 2 ? ["위험요소를 확인한 뒤 실습을 시작합니다", "이상 시 훈련을 중단하고 교관에게 보고합니다"]
        : index === count - 1 ? ["체크리스트 기준에 따라 수행 결과를 평가합니다", "누락 항목은 다시 시연하여 확인합니다"]
          : ["교관의 설명과 원문 확인 지점을 비교합니다", `예시 ${index + 1}의 확인 결과를 동료에게 설명합니다`],
      notes: enough(`${index === 1 ? SOP_NOT_FOUND_DISCLOSURE : ""}\n${DEMO_WARNING} 교관은 예시 화면에서 확인할 항목을 설명하고 대원은 결과를 관찰하여 말한다.`, 180),
      layout: index === 0 ? "objectives" : index === count - 2 ? "safety" : index === count - 1 ? "summary" : "concept",
      role: index === 0 ? "objectives" : index === count - 2 ? "safety" : index === count - 1 ? "summary" : "concept",
      composition: "list", visual: { mode: "native-diagram" }, sourceRefs: sourceLabels,
    }));
    result = { title, slides, mode: resolveSlideDeckMode(request.slideMode), ...common };
  } else if (request.type === "plan") {
    result = { title, ...common, sections: [
      { heading: "훈련목표", content: enough("대원은 제시된 확인 항목을 설명하고 교관의 체크리스트에 따라 수행 결과를 빠짐없이 확인한다.", 80) },
      { heading: "훈련내용", content: `[이론교육 · ${10 * ratio}분] 교관이 확인 항목을 설명한다.\n[교관시범 · ${10 * ratio}분] 교관은 확인 지점을 시범으로 보여 준다.\n[반복실습 · ${25 * ratio}분] ${actions}\n[종합수행 · ${15 * ratio}분] 대원은 피드백을 받은 항목을 다시 수행한다.\n${SOP_NOT_FOUND_DISCLOSURE}` },
      { heading: "필요장비", content: enough("교육용 자료와 체크리스트를 준비하고 사용 전 자료의 개정 상태와 실습 조건을 확인한다.", 70) },
      { heading: "안전관리", content: safety }, { heading: "훈련평가", content: evaluation },
    ] };
  } else {
    result = { title, ...common, sections: [
      { heading: "학습목표", content: enough("교육 후 대원은 확인 항목의 목적을 설명하고 수행 결과를 기록하며 누락이나 이상 상태를 발견해 보고할 수 있다.", 100) },
      { heading: "도입", content: `[시간: ${5 * ratio}분] ${enough("교관은 예시 화면과 교육 목표를 소개한다. 대원은 기존 경험과 비교하여 먼저 확인할 항목을 말한다.", 150)}` },
      { heading: "핵심이론", content: `[시간: ${10 * ratio}분] ${enough("원문 확인과 수행 결과 기록의 목적을 설명한다. 실제 기술 절차와 안전 수치는 이 화면 체험 예시에 포함하지 않는다.", 280)}\n${SOP_NOT_FOUND_DISCLOSURE}` },
      { heading: "교관시범", content: `[시간: ${10 * ratio}분] ${enough("교관은 자료를 여는 동작과 확인 결과를 기록하는 방법을 순서대로 시범 보인다. 대원은 각 확인 지점을 관찰하고 교관의 질문에 답한다.", 240)}` },
      { heading: "대원실습", content: `[시간: ${25 * ratio}분] ${actions}` },
      { heading: "안전유의사항", content: `[시간: ${5 * ratio}분] ${safety}` },
      { heading: "정리·평가", content: `[시간: ${5 * ratio}분] ${enough(evaluation, 200)}` },
    ] };
  }
  const report = inspectCurrentGenerationQuality(request.type, result, request.duration);
  return { ...result, demo: true, quality: { checked: true, repaired: false,
    ...generationQualityMessages(report, [DEMO_WARNING, "관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"]), issues: report.issues } };
}
