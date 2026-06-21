// 교육자료·훈련계획 생성 — 스키마·옵션·프롬프트의 단일 출처.
// UI는 클릭·선택형(자유 입력 최소화): 유형 × 분야 × 대상 × 시간 조합으로 생성한다.
import { z } from "zod";

// ── 생성 유형 ──
export const GEN_TYPES = [
  {
    key: "plan",
    label: "훈련계획",
    description: "목표·준비물·단계별 진행·평가가 담긴 훈련계획 문서",
  },
  {
    key: "lesson",
    label: "교육자료(교안)",
    description: "교육 시간에 바로 쓰는 강의용 교안(개요·본문·정리)",
  },
  {
    key: "slides",
    label: "슬라이드(PPTX)",
    description: "표준 양식 PPTX 슬라이드 자동 생성 (발표자 노트 포함)",
  },
  {
    key: "notebooklm",
    label: "NotebookLM 프롬프트",
    description: "NotebookLM에 붙여넣어 슬라이드를 만들 프롬프트 생성",
  },
] as const;
export type GenType = (typeof GEN_TYPES)[number]["key"];

// ── 선택 옵션 ──
export const AUDIENCES = ["신임 대원", "일반 대원", "전문 과정"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const DURATIONS = ["1시간", "2시간", "4시간"] as const;
export type Duration = (typeof DURATIONS)[number];

export type GenerateRequest = {
  type: GenType;
  category: string;
  audience: Audience;
  duration: Duration;
  topic?: string; // 선택: 훈련 내용/주제(예: "공기호흡기 점검")
  date?: string; // 선택: 훈련 일자 (YYYY-MM-DD)
  model?: string; // 선택: LLM 모델 키 (lib/llm.ts MODEL_OPTIONS, 미지정 시 서버 기본)
};

// ── 생성 결과 ──
export const generatedDocSchema = z.object({
  title: z.string().describe("문서 제목 (분야·주제·시간이 드러나게)"),
  sections: z
    .array(
      z.object({
        heading: z.string().describe("섹션 제목 (번호 포함, 예: '1. 훈련 개요')"),
        content: z.string().describe("섹션 본문. 줄바꿈(\\n)으로 항목 구분"),
      })
    )
    .min(3)
    .max(8),
});

export type GeneratedSection = z.infer<typeof generatedDocSchema>["sections"][number];

export type GeneratedDocSource = {
  document_id: number;
  doc: string;
  page: number | null;
};

export type GeneratedDoc = {
  title: string;
  sections: GeneratedSection[];
  sources: GeneratedDocSource[];
};

// ── 슬라이드(PPTX) 생성 결과 ──
export const generatedSlidesSchema = z.object({
  title: z.string().describe("발표 제목 (분야·주제가 드러나게, 25자 이내)"),
  slides: z
    .array(
      z.object({
        title: z.string().describe("슬라이드 제목 (간결하게)"),
        bullets: z
          .array(z.string().describe("핵심 문장 (한 줄, 40자 이내)"))
          .min(1)
          .max(4),
        notes: z.string().describe("발표자 노트 — 교관이 읽을 설명 대본 2~4문장"),
      })
    )
    .min(6)
    .max(20),
});

export type GeneratedSlide = z.infer<typeof generatedSlidesSchema>["slides"][number];

export type GeneratedSlideDeck = {
  title: string;
  slides: GeneratedSlide[];
  sources: GeneratedDocSource[];
};

// ── 프롬프트 ──
// 시간별 권장 슬라이드 수 (NotebookLM 안내와 동일 기준, 스키마 상한 20장)
export function slideCountFor(duration: Duration): string {
  return duration === "1시간" ? "10~12" : duration === "2시간" ? "14~18" : "18~20";
}

const TYPE_GUIDE: Record<Exclude<GenType, "notebooklm" | "slides">, string> = {
  plan: `훈련계획 문서를 작성하세요. 다음 구성을 따르세요:
1. 훈련 개요 (대상·시간·장소·목표)
2. 준비물·안전조치 (장비 목록과 훈련 전 점검사항, 안전관리관 지정)
3. 단계별 진행 (시간 배분을 명시한 이론→실습→종합 순서)
4. 평가·강평 (숙달 확인 방법)`,
  lesson: `강의용 교안을 작성하세요. 다음 구성을 따르세요:
1. 학습 목표 (이 교육을 마치면 할 수 있어야 하는 것)
2. 도입 (현장 사례나 질문으로 동기 부여)
3. 본문 (핵심 내용을 소단원으로 나눠 설명, 시범·실습 포인트 표시)
4. 정리·평가 (핵심 요약과 확인 질문)`,
};

export function buildGeneratePrompt(req: GenerateRequest): string {
  if (req.type === "notebooklm") {
    throw new Error("notebooklm 유형은 buildNotebookLmPrompt 를 사용하세요.");
  }
  const topicLine = req.topic?.trim()
    ? `훈련 내용(주제): ${req.topic.trim()}`
    : "훈련 내용(주제): 분야 전반에서 가장 중요한 주제를 선정";
  const dateLine = req.date ? `\n- 훈련 일자: ${req.date} (문서 개요에 명시)` : "";

  if (req.type === "slides") {
    return `전북소방본부 ${req.category} 분야 교육용 슬라이드를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration} (슬라이드 ${slideCountFor(req.duration)}장)
- ${topicLine}

[구성]
① 학습 목표 1장 ② 핵심 개념·절차 (단계별로 1장씩) ③ 현장 적용 사례
④ 안전 유의사항 ⑤ 핵심 요약 1장

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- 각 슬라이드: 간결한 제목 + 핵심 문장 최대 4개(한 줄씩) + 발표자 노트(교관용 설명 대본 2~4문장).
- 대상 수준(${req.audience})에 맞는 용어와 난이도로, 한국어로 작성하세요.`;
  }

  return `전북소방본부 ${req.category} 분야 ${
    req.type === "plan" ? "훈련계획" : "교육자료(교안)"
  }를 작성합니다.

- 대상: ${req.audience}
- 교육 시간: ${req.duration}
- ${topicLine}${dateLine}

${TYPE_GUIDE[req.type]}

[작성 규칙]
- 반드시 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- 대상 수준(${req.audience})에 맞는 난이도와 분량으로 작성하세요.
- 시간 배분의 합이 교육 시간(${req.duration})과 일치해야 합니다.
- 한국어로, 현장에서 바로 쓸 수 있게 구체적으로 작성하세요.`;
}

// ── 저장된 생성물 (이력) ──
// content 는 kind 에 따라 { sections, sources } | { slides, sources } | { prompt } 형태.
export type SavedMaterial = {
  id: number;
  kind: GenType;
  category: string | null;
  audience: string | null;
  duration: string | null;
  topic: string | null;
  title: string;
  content: unknown;
  created_at: string;
};

// ── 부분 재생성 (섹션/슬라이드 1개) ──
export const regeneratedSectionSchema = z.object({
  heading: z.string().describe("섹션 제목 (번호 포함, 예: '3. 단계별 진행')"),
  content: z.string().describe("섹션 본문. 줄바꿈(\\n)으로 항목 구분"),
});

export const regeneratedSlideSchema = z.object({
  title: z.string().describe("슬라이드 제목 (간결하게)"),
  bullets: z.array(z.string().describe("핵심 문장 (한 줄, 40자 이내)")).min(1).max(4),
  notes: z.string().describe("발표자 노트 — 교관이 읽을 설명 대본 2~4문장"),
});

// 부분 재생성 지시(프리셋) — 클라이언트가 보내는 자연어 지시. 직접 입력도 허용.
export const REGEN_INSTRUCTIONS = [
  { key: "detail", label: "더 자세히", text: "내용을 더 구체적이고 자세하게, 단계와 수치를 보강해 작성" },
  { key: "concise", label: "더 간결히", text: "핵심만 남겨 더 간결하고 명확하게 작성" },
  { key: "example", label: "현장 사례 추가", text: "현장 적용 사례나 예시를 포함해 작성" },
] as const;

// 섹션 1개 재생성 프롬프트 — 전체 구성(outline) 안에서 해당 섹션만 다시 쓴다.
export function buildSectionRegenPrompt(args: {
  category: string;
  audience: Audience;
  duration: Duration;
  docTitle: string;
  outline: string[];
  index: number;
  currentHeading: string;
  currentContent: string;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  return `전북소방본부 ${args.category} 분야 교육 문서 "${args.docTitle}"의 한 섹션만 다시 작성합니다.

[문서 전체 구성]
${outlineText}

[다시 작성할 섹션] ${args.index + 1}번째 — "${args.currentHeading}"
[현재 내용]
${args.currentContent}${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- 다른 섹션과 중복되지 않게, 이 섹션의 역할에 충실하게 작성하세요.
- 대상 수준(${args.audience})·교육 시간(${args.duration})에 맞춰 한국어로 작성하세요.
- 이 섹션 하나만 JSON으로 반환하세요(heading, content).`;
}

// 슬라이드 1개 재생성 프롬프트 — 전체 슬라이드 구성 안에서 해당 1장만 다시 쓴다.
export function buildSlideRegenPrompt(args: {
  category: string;
  audience: Audience;
  duration: Duration;
  deckTitle: string;
  outline: string[];
  index: number;
  current: GeneratedSlide;
  instruction?: string;
}): string {
  const outlineText = args.outline.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const instr = args.instruction?.trim()
    ? `\n[수정 지시] ${args.instruction.trim()}`
    : "";
  return `전북소방본부 ${args.category} 분야 발표 "${args.deckTitle}"의 슬라이드 한 장만 다시 작성합니다.

[발표 전체 구성]
${outlineText}

[다시 작성할 슬라이드] ${args.index + 1}번째 — "${args.current.title}"
[현재 내용]
${args.current.bullets.map((b) => `· ${b}`).join("\n")}
(노트: ${args.current.notes})${instr}

[작성 규칙]
- 위 '참고 자료'에 있는 내용만 근거로 작성하세요. 자료에 없는 절차·수치를 지어내지 마세요.
- 다른 슬라이드와 중복되지 않게 작성하세요.
- 제목 + 핵심 문장 최대 4개(한 줄씩) + 발표자 노트(2~4문장).
- 대상 수준(${args.audience})에 맞는 용어로 한국어로, 이 슬라이드 하나만 JSON으로 반환하세요.`;
}

// NotebookLM에 붙여넣는 프롬프트 — AI 호출 없이 조립(데모·내부망에서도 동일 동작).
// docTitles: 인덱싱(벡터DB)된 해당 분야 자료 제목 — 어떤 자료를 업로드할지 안내에 포함.
export function buildNotebookLmPrompt(
  req: GenerateRequest,
  docTitles: string[] = []
): string {
  const topic = req.topic?.trim() || `${req.category} 분야 핵심 주제`;
  const materials =
    docTitles.length > 0
      ? `\n\n업로드할 자료 (플랫폼에 인덱싱된 ${req.category} 분야 자료):\n${docTitles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "";
  return `업로드한 전북소방 ${req.category} 분야 교육자료를 바탕으로 "${topic}" 교육용 슬라이드를 만들어 주세요.${materials}

조건:
- 대상: ${req.audience} (이 수준에 맞는 용어와 난이도로)
- 교육 시간: ${req.duration} 분량 (슬라이드 ${
    req.duration === "1시간" ? "10~15" : req.duration === "2시간" ? "20~25" : "30~40"
  }장)
- 구성: ① 학습 목표 1장 ② 핵심 개념·절차 (단계별로 1장씩, 그림 위치 표시) ③ 현장 적용 사례 ④ 안전 유의사항 ⑤ 핵심 요약·퀴즈 1장
- 각 슬라이드: 제목 + 핵심 문장 3개 이하 + 발표자 노트(설명 대본)
- 자료에 없는 내용은 넣지 말고, 각 슬라이드에 근거 자료의 쪽 번호를 표시해 주세요.
- 전북소방본부 교육용이므로 격식 있는 한국어로 작성해 주세요.`;
}
