// 키 없는 데모/미리보기 모드. NEXT_PUBLIC_DEMO_MODE=1 일 때 Supabase/Anthropic/OpenAI 호출 없이
// 목 데이터로 전체 UI를 둘러볼 수 있게 한다. 실제 흐름 코드는 if (DEMO) 가드로만 분기.
import { buildCourses, type LessonDoc } from "@/lib/courses";
import { calcWeekly } from "@/lib/fitness";
import type { DocSource } from "@/lib/database.types";
import type { GeneratedQuestion } from "@/lib/quiz";

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

const demoCompleted = new Set<number>([1, 4, 6, 8]);
const demoPassedCategories = new Set<string>(["화재"]);

export const demoLessonDocs: LessonDoc[] = demoDocuments.map((d) => ({
  id: d.id,
  title: d.title,
  category: d.category,
  difficulty: d.difficulty,
  publish_date: d.publish_date,
}));

export function getDemoLearningState() {
  const courses = buildCourses(demoLessonDocs, demoCompleted, demoPassedCategories);
  const totalLessons = courses.reduce((s, c) => s + c.total, 0);
  const totalCompleted = courses.reduce((s, c) => s + c.completed, 0);
  return {
    courses,
    completedIds: demoCompleted,
    passedCategories: demoPassedCategories,
    totalLessons,
    totalCompleted,
    overallProgress:
      totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0,
  };
}

export function isDemoCompleted(documentId: number): boolean {
  return demoCompleted.has(documentId);
}

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

export const demoQuizQuestions: GeneratedQuestion[] = [
  {
    question: "공기호흡기 착용 전 가장 먼저 확인해야 하는 것은?",
    choices: ["면체 밀착 상태", "헬멧 색상", "무전기 채널", "장갑 두께"],
    answerIndex: 0,
    explanation: "면체가 밀착되지 않으면 유독가스가 유입될 수 있어 가장 먼저 확인합니다.",
    source: "공기호흡기 착용 절차",
  },
  {
    question: "실린더 충전 압력의 통상 기준에 가장 가까운 값은?",
    choices: ["50bar", "150bar", "300bar", "1000bar"],
    answerIndex: 2,
    explanation: "일반적으로 약 300bar 내외로 충전 상태를 확인합니다.",
    source: "공기호흡기 착용 절차",
  },
  {
    question: "잔압 경보장치의 목적으로 옳은 것은?",
    choices: ["배터리 잔량 표시", "공기 잔량 부족 경고", "온도 표시", "위치 추적"],
    answerIndex: 1,
    explanation: "잔압 경보는 공기 잔량이 부족할 때 탈출을 유도합니다.",
    source: "공기호흡기 착용 절차",
  },
  {
    question: "내화 진입 시 대형 유지의 주된 이유는?",
    choices: ["사진 촬영", "상호 안전 확보와 길잃음 방지", "장비 절약", "통신 차단"],
    answerIndex: 1,
    explanation: "대형을 유지하면 상호 확인이 가능해 길잃음·고립을 방지합니다.",
    source: "내화 진입과 대형 유지",
  },
  {
    question: "면체 누설 점검은 어느 상태에서 하는가?",
    choices: ["전원 차단", "양압 작동 상태", "실린더 분리", "수중"],
    answerIndex: 1,
    explanation: "양압 작동 상태에서 누설 여부를 확인한 뒤 진입합니다.",
    source: "공기호흡기 착용 절차",
  },
];

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
      "급류 구조 기초 개정판(2026)이 자료실에 등록되었습니다. 수난 분야 과정 진도에 반영되니 학습 후 퀴즈로 이수를 갱신하세요.",
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

// ── 마이페이지: 퀴즈 기록 ──
export const demoQuizAttempts = [
  { id: 3, category: "화재", score: 5, total: 5, passed: true, created_at: "2026-06-07T10:20:00.000Z" },
  { id: 2, category: "산악", score: 3, total: 5, passed: false, created_at: "2026-06-03T16:05:00.000Z" },
  { id: 1, category: "화재", score: 4, total: 5, passed: true, created_at: "2026-05-29T09:40:00.000Z" },
];

// ── 관리자: 이수 현황 ──
export const demoCompletionUsers = [
  { id: "demo-user", full_name: "데모 대원", email: "demo@jbfire.go.kr", division: "전북소방 구조대", lessonsDone: 4, passedCategories: ["화재"] },
  { id: "u1", full_name: "김구조", email: "kim@jbfire.go.kr", division: "전주 119구조대", lessonsDone: 9, passedCategories: ["산악", "화재", "구급"] },
  { id: "u2", full_name: "이수난", email: "lee@jbfire.go.kr", division: "군산 119구조대", lessonsDone: 7, passedCategories: ["수난", "구급"] },
  { id: "u3", full_name: "박산악", email: "park@jbfire.go.kr", division: "남원 119구조대", lessonsDone: 5, passedCategories: ["산악"] },
  { id: "u4", full_name: "최화재", email: "choi@jbfire.go.kr", division: "익산 119구조대", lessonsDone: 2, passedCategories: [] },
];

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
    lessonCompletions: 96,
    quizAttempts: 58,
    quizPassed: 47,
    quizPassRate: 81,
    quizAvg: 78,
    fitnessActiveUsers: 18,
    fitnessMonthPoints: 5840,
    fitnessTotalLogs: 214,
  };
}
