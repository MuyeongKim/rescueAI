// 키 없는 데모/미리보기 모드. NEXT_PUBLIC_DEMO_MODE=1 일 때 Supabase/Anthropic/OpenAI 호출 없이
// 목 데이터로 전체 UI를 둘러볼 수 있게 한다. 실제 흐름 코드는 if (DEMO) 가드로만 분기.
import { calcWeekly } from "@/lib/fitness";
import type { DocSource } from "@/lib/database.types";
import type { GeneratedDoc, GeneratedSlideDeck } from "@/lib/generate";

export const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

export const demoUser = { id: "demo-user", email: "demo@jbfire.go.kr" };
export const demoProfile = {
  id: "demo-user",
  email: "demo@jbfire.go.kr",
  full_name: "데모 대원",
  role: "admin",
  division: "전북소방 구조대",
  created_at: "2026-01-01T00:00:00.000Z",
};

type DemoDoc = {
  id: number;
  title: string;
  category: string;
  difficulty: string;
  publish_date: string;
  equipment: string[];
  source_type: string;
};

export const demoDocuments: DemoDoc[] = [
  { id: 1, title: "로프 매듭 기본", category: "산악", difficulty: "초급", publish_date: "2024-03-01", equipment: ["로프"], source_type: "pdf" },
  { id: 2, title: "확보물 설치와 빌레이", category: "산악", difficulty: "중급", publish_date: "2024-04-10", equipment: ["하강기", "안전벨트"], source_type: "pdf" },
  { id: 3, title: "고각도 암벽 인명구조", category: "산악", difficulty: "고급", publish_date: "2024-06-20", equipment: ["로프", "도르래"], source_type: "pdf" },
  { id: 4, title: "구명조끼·스로백 사용법", category: "수난", difficulty: "초급", publish_date: "2024-02-15", equipment: ["구명조끼", "스로백"], source_type: "pdf" },
  { id: 5, title: "급류 구조 기초", category: "수난", difficulty: "중급", publish_date: "2024-05-05", equipment: ["구명조끼"], source_type: "pdf" },
  { id: 6, title: "공기호흡기 착용 절차", category: "화재", difficulty: "초급", publish_date: "2024-01-20", equipment: ["공기호흡기"], source_type: "pdf" },
  { id: 7, title: "내화 진입과 대형 유지", category: "화재", difficulty: "중급", publish_date: "2024-07-01", equipment: ["방화복", "열화상카메라"], source_type: "pdf" },
  { id: 8, title: "심폐소생술(CPR) 순서", category: "구급", difficulty: "초급", publish_date: "2024-03-30", equipment: ["AED"], source_type: "pdf" },
  { id: 9, title: "외상 환자 1차 평가", category: "구급", difficulty: "중급", publish_date: "2024-08-12", equipment: ["부목"], source_type: "pdf" },
];

export const demoConversations = [
  { id: "demo-conv-1", title: "공기호흡기 점검 절차", updated_at: "2026-05-30T09:12:00.000Z" },
  { id: "demo-conv-2", title: "급류 구조 시 접근 방법", updated_at: "2026-05-29T17:40:00.000Z" },
];

export const demoChatSources: DocSource[] = [
  { document_id: 6, doc: "공기호흡기 착용 절차", page: 3, content: "사용 전 면체 밀착 점검, 잔압계로 충전 압력(보통 300bar 내외) 확인, 경보장치 작동 여부를 점검한다." },
  { document_id: 6, doc: "공기호흡기 착용 절차", page: 4, content: "양압 작동 상태에서 면체 누설 여부를 확인하고, 잔압 경보가 정상 작동하는지 확인 후 진입한다." },
];

export const demoChatAnswer =
  "공기호흡기는 사용 전 다음을 점검합니다.\n\n1. 면체 밀착 상태 확인\n2. 실린더 충전 압력(약 300bar) 확인\n3. 잔압 경보장치 작동 확인\n4. 양압 상태에서 면체 누설 점검\n\n점검이 끝나면 양압을 유지한 채 진입하세요.\n\n[근거: 공기호흡기 착용 절차 p.3]";

// ── AI 자료제작 (훈련계획/교안) ──
export const demoGeneratedDoc: GeneratedDoc = {
  title: "화재 분야 훈련계획 — 공기호흡기 착용·내화 진입 (2시간)",
  sections: [
    {
      heading: "1. 훈련 개요",
      content:
        "대상: 일반 구조대원 / 시간: 2시간 / 장소: 소방서 훈련장\n목표: 공기호흡기 사용 전 점검 절차를 숙달하고, 내화 진입 시 대형 유지 요령을 체득한다.",
    },
    {
      heading: "2. 준비물·안전조치",
      content:
        "공기호흡기 세트(인원수+예비 1), 방화복, 열화상카메라 1대.\n훈련 전 실린더 충전 압력(약 300bar)과 잔압 경보장치 작동을 전수 점검하고, 안전관리관 1명을 지정한다.",
    },
    {
      heading: "3. 단계별 진행 (120분)",
      content:
        "① 이론·시범 (30분): 면체 밀착 점검 → 충전 압력 확인 → 잔압 경보 확인 → 양압 누설 점검 순서 시범.\n② 분임 실습 (60분): 2인 1조로 착용 절차 반복, 조별 교차 점검.\n③ 종합 훈련 (30분): 양압 유지 상태로 농연 환경 모의 진입, 대형 유지·상호 확인 훈련.",
    },
    {
      heading: "4. 평가·강평",
      content:
        "착용 절차 4단계 누락 없이 수행하는지 조별 체크리스트로 확인하고, 진입 훈련 중 대형 이탈 사례를 강평에서 공유한다.",
    },
  ],
  sources: [
    { document_id: 6, doc: "공기호흡기 착용 절차", page: 3 },
    { document_id: 7, doc: "내화 진입과 대형 유지", page: 2 },
  ],
};

export const demoGeneratedSlides: GeneratedSlideDeck = {
  title: "화재 — 공기호흡기 착용과 내화 진입",
  slides: [
    {
      title: "학습 목표",
      bullets: [
        "공기호흡기 사용 전 점검 4단계를 순서대로 수행한다",
        "양압 상태 확인 후 안전하게 진입한다",
        "내화 진입 시 대형 유지 요령을 설명한다",
      ],
      notes:
        "이번 교육의 세 가지 목표를 먼저 공유합니다. 점검 절차는 순서가 핵심이므로 4단계를 끝까지 강조해 주세요.",
    },
    {
      title: "점검 1단계 — 면체 밀착 확인",
      bullets: [
        "면체와 안면부 사이 틈새 여부 확인",
        "밀착되지 않으면 유독가스 유입 위험",
      ],
      notes:
        "가장 먼저 면체 밀착 상태를 확인합니다. 머리카락이나 두건이 끼면 밀착이 깨질 수 있다는 점을 시범으로 보여주세요.",
    },
    {
      title: "점검 2단계 — 충전 압력 확인",
      bullets: ["잔압계로 충전 압력 확인 (통상 약 300bar)", "기준 미달 실린더는 교체"],
      notes:
        "잔압계를 직접 보여주며 300bar 내외 기준을 설명합니다. 압력이 낮은 실린더를 들고 진입하는 사례가 없도록 강조하세요.",
    },
    {
      title: "점검 3단계 — 잔압 경보 확인",
      bullets: ["경보장치 작동 여부 점검", "공기 잔량 부족 시 탈출 신호"],
      notes:
        "잔압 경보는 탈출 타이밍을 알려주는 생명줄입니다. 경보음을 실제로 들려주고 울리면 즉시 탈출이라는 원칙을 심어주세요.",
    },
    {
      title: "점검 4단계 — 양압 누설 점검",
      bullets: ["양압 작동 상태에서 면체 누설 확인", "점검 완료 후 양압 유지한 채 진입"],
      notes:
        "양압 상태에서 면체 가장자리 누설을 확인합니다. 여기까지 4단계가 끝나야 진입 준비가 완료됩니다.",
    },
    {
      title: "내화 진입 — 대형 유지",
      bullets: [
        "진입조는 대형을 유지하며 상호 확인",
        "대형 이탈은 길잃음·고립으로 직결",
        "열화상카메라로 시야 보완",
      ],
      notes:
        "농연 속에서는 1m 앞도 보이지 않습니다. 대형 유지가 곧 상호 안전 확보임을 사례와 함께 설명하세요.",
    },
    {
      title: "핵심 요약",
      bullets: [
        "점검 4단계: 밀착 → 압력 → 경보 → 누설",
        "양압 유지 상태로 진입",
        "대형 유지 = 상호 안전",
      ],
      notes: "마지막으로 점검 순서를 구호로 함께 복창하며 마무리합니다.",
    },
  ],
  sources: [
    { document_id: 6, doc: "공기호흡기 착용 절차", page: 3 },
    { document_id: 7, doc: "내화 진입과 대형 유지", page: 2 },
  ],
};

// ── 공지사항 ──
export const demoNotices = [
  {
    id: 3,
    title: "6월 구조 기술 경연대회 안내",
    content:
      "6월 25일(목) 전북소방학교에서 구조 기술 경연대회가 열립니다. 분야별 대표는 6월 18일까지 소속 팀장에게 신청하세요.",
    pinned: true,
    created_at: "2026-06-05T09:00:00.000Z",
  },
  {
    id: 2,
    title: "수난구조 신규 교육자료 등록",
    content:
      "급류 구조 기초 개정판(2026)이 자료실에 등록되었습니다. 자료실에서 원본을 열람하고, AI 튜터로 관련 내용을 질의할 수 있습니다.",
    pinned: false,
    created_at: "2026-06-02T14:30:00.000Z",
  },
  {
    id: 1,
    title: "체력단련 마일리지 제도 시행",
    content:
      "운동 기록을 등록하면 1분당 1마일리지가 적립됩니다(일일 상한 120점). 월간 랭킹은 체력단련 메뉴에서 확인할 수 있습니다.",
    pinned: false,
    created_at: "2026-05-28T08:00:00.000Z",
  },
];

// ── 체력단련 마일리지 ──
export function getDemoFitnessState() {
  // 주차 라벨은 실제 달력 기준으로 생성하고 값만 보기 좋은 가짜 추이를 넣는다.
  const weekly = calcWeekly([]).map((w, i) => ({
    ...w,
    points: [140, 180, 150, 210, 95, 160, 240, 195][i] ?? 0,
  }));
  return {
    totalPoints: 1240,
    monthPoints: 380,
    monthRank: 3,
    streakDays: 4,
    weekly,
    recent: [
      { id: 6, activity: "달리기", duration_min: 40, note: "5km 인터벌", points: 40, performed_on: "2026-06-09" },
      { id: 5, activity: "근력운동", duration_min: 60, note: "하체·코어", points: 60, performed_on: "2026-06-08" },
      { id: 4, activity: "등산", duration_min: 120, note: "모악산 훈련", points: 120, performed_on: "2026-06-06" },
      { id: 3, activity: "수영", duration_min: 45, note: null, points: 45, performed_on: "2026-06-04" },
      { id: 2, activity: "달리기", duration_min: 30, note: null, points: 30, performed_on: "2026-06-02" },
      { id: 1, activity: "근력운동", duration_min: 50, note: "상체", points: 50, performed_on: "2026-06-01" },
    ],
    leaderboard: [
      { user_id: "u1", full_name: "김구조", division: "전주 119구조대", total_points: 520 },
      { user_id: "u2", full_name: "이수난", division: "군산 119구조대", total_points: 455 },
      { user_id: "demo-user", full_name: "데모 대원", division: "전북소방 구조대", total_points: 380 },
      { user_id: "u3", full_name: "박산악", division: "남원 119구조대", total_points: 310 },
      { user_id: "u4", full_name: "최화재", division: "익산 119구조대", total_points: 265 },
    ],
  };
}

// ── 관리자: 사용자 목록 ──
export const demoUsers = [
  { id: "demo-user", email: "demo@jbfire.go.kr", full_name: "데모 대원", role: "admin", division: "전북소방 구조대", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "u1", email: "kim@jbfire.go.kr", full_name: "김구조", role: "user", division: "전주 119구조대", created_at: "2026-02-10T00:00:00.000Z" },
  { id: "u2", email: "lee@jbfire.go.kr", full_name: "이수난", role: "user", division: "군산 119구조대", created_at: "2026-02-12T00:00:00.000Z" },
  { id: "u3", email: "park@jbfire.go.kr", full_name: "박산악", role: "user", division: "남원 119구조대", created_at: "2026-03-02T00:00:00.000Z" },
  { id: "u4", email: "choi@jbfire.go.kr", full_name: "최화재", role: "user", division: "익산 119구조대", created_at: "2026-03-15T00:00:00.000Z" },
];

const DAY_MS = 86_400_000;

export function getDemoAdminStats() {
  const daily: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    // 보기 좋은 가짜 추이
    const count = [2, 3, 5, 4, 6, 8, 7, 5, 9, 11][i % 10];
    daily.push({ date: d, count });
  }
  return {
    totalUsers: 24,
    totalQuestions: 318,
    avgLatencyMs: 2300,
    satisfaction: 86,
    up: 142,
    down: 23,
    categories: [
      { category: "화재", count: 41 },
      { category: "산악", count: 33 },
      { category: "구급", count: 28 },
      { category: "수난", count: 19 },
    ],
    daily,
    faq: [
      { q: "공기호흡기 착용 전 점검 절차 알려줘", count: 27 },
      { q: "급류 구조 시 요구조자 접근 방법은?", count: 19 },
      { q: "심폐소생술 압박 깊이와 속도", count: 18 },
      { q: "유압전개기 안전 사용 수칙", count: 14 },
      { q: "로프 하강 시 확보 방법", count: 11 },
    ],
    fitnessActiveUsers: 18,
    fitnessMonthPoints: 5840,
    fitnessTotalLogs: 214,
  };
}
