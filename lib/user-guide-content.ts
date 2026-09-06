/** 안내창과 전체 사용설명서가 함께 사용하는 안내 내용. */
export const USER_GUIDE_VERSION = "2026-09-06.1";

export const USER_GUIDE_QUICK_STEPS: {
  title: string;
  description: string;
  href: string;
  label: string;
}[] = [
  {
    title: "AI 튜터",
    description: "궁금한 상황을 적고 질문하세요. 답변에 붙은 출처와 페이지도 함께 확인하세요.",
    href: "/chat",
    label: "질문하러 가기",
  },
  {
    title: "AI 자료제작",
    description: "훈련계획·교안·슬라이드를 만드세요. 주제, 교육 대상, 시간을 적으면 시작할 수 있습니다.",
    href: "/generate",
    label: "자료 만들러 가기",
  },
  {
    title: "자료실",
    description: "매뉴얼 원본을 찾아 읽으세요. 자료 제목으로 검색하거나 분야와 난이도를 고를 수 있습니다.",
    href: "/docs",
    label: "원본 보러 가기",
  },
];

export const USER_GUIDE_SECTIONS = [
  { id: "start", title: "처음에는 여기서 시작하세요", shortTitle: "메뉴 찾기", description: "질문, 자료 만들기, 원본 읽기. 할 일에 맞는 메뉴를 고르세요." },
  { id: "ask", title: "AI 튜터에게 질문하세요", shortTitle: "AI 튜터", description: "상황을 구체적으로 적을수록 필요한 내용을 찾는 데 도움이 됩니다." },
  { id: "create", title: "필요한 훈련자료를 만드세요", shortTitle: "자료 만들기", description: "무엇을, 누구에게, 얼마 동안 가르칠지 알려주세요." },
  { id: "review", title: "내용을 확인하고 파일로 받으세요", shortTitle: "확인·다운로드", description: "AI가 만든 뒤에는 내가 내용을 읽고 고치는 차례입니다." },
  { id: "resume", title: "하던 작업을 다시 여세요", shortTitle: "이어서 작업", description: "잠시 멈춘 작업과 저장한 자료는 서로 다른 곳에서 찾습니다." },
  { id: "library", title: "원본과 새 소식도 확인하세요", shortTitle: "자료실·새 소식", description: "원본 교육자료와 플랫폼의 다른 메뉴를 함께 활용하세요." },
] as const;

export type UserGuideSectionId = (typeof USER_GUIDE_SECTIONS)[number]["id"];

export const USER_GUIDE_QUESTION_EXAMPLE =
  "신규 대원 교육용으로 공기호흡기 착용 전 점검 항목을 알려줘. 준비 순서와 주의사항을 나눠서 설명해줘.";

export const USER_GUIDE_QUESTION_PARTS = [
  { title: "상황·대상", text: "신규 대원 교육용으로" },
  { title: "장비·주제", text: "공기호흡기 착용 전 점검 항목을" },
  { title: "원하는 답변", text: "준비 순서와 주의사항으로 나눠서" },
];

export const USER_GUIDE_CREATE_STEPS = [
  { title: "자료 종류를 고르세요", text: "훈련을 준비하려면 ‘훈련계획’, 가르칠 내용을 정리하려면 ‘교안’, 발표할 화면이 필요하면 ‘슬라이드’를 고르세요." },
  { title: "분야와 주제를 적으세요", text: "예: ‘화재 / 공기호흡기 착용 전 점검’. 분야나 세부 방향을 추천받으면 내가 하려는 교육과 맞는지 확인하세요." },
  { title: "대상과 시간을 알려주세요", text: "예: ‘신규 대원 / 30분’. 장소·장비 등 현장 조건은 필요한 내용만 추가하세요." },
  { title: "구성을 확인하고 제작하세요", text: "‘전체 생성 전에 구성 확인’을 켜면 목차와 시간 배분을 먼저 봅니다. 생성 중에는 화면의 진행 안내를 확인하세요." },
];

export const USER_GUIDE_STORAGE_ITEMS = [
  { title: "이어서 작업하기", description: "진행 중인 제작 작업과 자동보관된 편집 초안을 다시 엽니다.", action: "AI 자료제작 화면 아래에서 펼치세요." },
  { title: "저장한 자료", description: "‘저장’ 또는 ‘수정 저장’을 눌러 보관한 결과를 다시 엽니다.", action: "저장 후 ‘저장됨’ 표시를 확인하세요." },
  { title: "다운로드", description: "현재 자료를 내 컴퓨터나 휴대전화의 파일로 받습니다.", action: "다운로드는 플랫폼의 ‘저장’과 별개입니다." },
];

export const USER_GUIDE_HELP = [
  {
    question: "‘관련 자료에서 확인되지 않는다’고 나와요.",
    answer: "현재 질문을 뒷받침할 근거를 충분히 찾지 못했다는 뜻입니다. 장비 이름, 상황, 확인할 내용을 더 적어보세요. 그래도 찾지 못하면 자료실의 원본을 확인하거나 자료 담당자에게 문의하세요. 해당 내용이 어디에도 없다는 뜻은 아닙니다.",
  },
  {
    question: "‘자료 검색이 일시적으로 원활하지 않다’고 나와요.",
    answer: "자료가 없다는 안내와 다릅니다. 검색 기능이 잠시 원활하지 않아 답변의 근거가 줄어들 수 있습니다. 잠시 후 다시 시도하고, 당장 확인해야 할 내용은 원본 자료에서 찾아보세요.",
  },
  {
    question: "제작이 오래 걸리면 화면을 닫아도 되나요?",
    answer: "‘화면을 닫아도 계속 진행됩니다’라는 안내가 나온 뒤에는 나중에 다시 열 수 있습니다. 아직 접수나 연결을 확인하는 중이라면 화면을 유지하세요. 돌아왔을 때 ‘이어서 작업하기’를 펼치면 됩니다.",
  },
  {
    question: "저장이나 다운로드 버튼이 눌리지 않아요.",
    answer: "근거를 확인 중이거나 고쳐야 할 내용이 남아 있을 수 있습니다. 결과 위의 안내를 읽고 표시된 항목부터 수정하세요. 다시 시도하라는 안내가 있으면 해당 버튼을 누르세요.",
  },
];
