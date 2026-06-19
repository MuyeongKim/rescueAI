// 구조 동향(뉴스) 데이터 — 자동 수집(검색 API + 매일 아침 cron) 연동 전 자리표시.
// /news 전체 목록과 홈 대시보드 미리보기가 공유한다. 실제 연동 시 이 모듈만 교체하면 됨.
// TF 구성안: "최신 동향 송출 — 전국·해외 구조기법·재난 뉴스 자동 검색·요약·송출".

export type NewsItem = {
  id: number;
  title: string;
  summary: string;
  source: string;
  region: "전국" | "해외";
  category: string;
  date: string;
};

export const NEWS_ITEMS: NewsItem[] = [
  {
    id: 1,
    title: "○○소방본부, 급류 구조 신형 수상드론 도입",
    summary:
      "급류 사고 현장에서 구조대원 진입 전 요구조자에게 구명환을 신속 투하할 수 있는 수상드론을 도입, 시범 운영에 들어갔다.",
    source: "소방청 보도자료",
    region: "전국",
    category: "수난",
    date: "2026-06-11",
  },
  {
    id: 2,
    title: "독일 THW, 붕괴 현장 AI 음향 탐지 시스템 실전 배치",
    summary:
      "잔해 속 생존자의 미세한 소리를 AI가 분류해 탐지 시간을 평균 40% 단축했다는 실증 결과를 발표했다.",
    source: "해외 소방·구조 동향",
    region: "해외",
    category: "붕괴·매몰",
    date: "2026-06-11",
  },
  {
    id: 3,
    title: "여름철 물놀이 사고 대비 전국 수난구조 합동훈련 실시",
    summary:
      "본격 휴가철을 앞두고 하천·계곡 중심의 합동훈련이 전국에서 실시된다. 스로백 투척·급류 횡단 구조가 중점 평가 항목.",
    source: "소방 뉴스",
    region: "전국",
    category: "수난",
    date: "2026-06-10",
  },
  {
    id: 4,
    title: "전기차 화재 진압 신기술 — 이동식 침수조 표준 운영지침 배포",
    summary:
      "전기차 배터리 열폭주 대응을 위한 이동식 침수조 표준 운영지침이 각 시도 소방본부에 배포됐다.",
    source: "소방청 보도자료",
    region: "전국",
    category: "화재",
    date: "2026-06-10",
  },
  {
    id: 5,
    title: "일본 도쿄소방청, 산악구조에 고성능 드론 열화상 탐색 도입",
    summary:
      "야간 산악 실종자 탐색에 열화상 드론을 투입해 평균 탐색 시간을 절반으로 줄였다고 발표했다.",
    source: "해외 소방·구조 동향",
    region: "해외",
    category: "산악",
    date: "2026-06-09",
  },
];

export function getRecentNews(limit = 3): NewsItem[] {
  return NEWS_ITEMS.slice(0, limit);
}
