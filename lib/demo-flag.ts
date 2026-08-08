// 데모 모드 플래그 — 미들웨어(edge)에서도 import 하므로 의존성 없이 가볍게 유지한다.
//
// 데모 모드는 미들웨어의 인증 검사를 통째로 통과시키고 모든 route handler 를 목 응답으로
// 바꾼다. 즉 이 플래그 하나가 켜지면 앱에 자물쇠가 없다. NEXT_PUBLIC_ 변수라 클라이언트
// 번들·Vercel 프로젝트 설정 어디서든 실수로 켜질 수 있으므로, **실제 Supabase 백엔드가
// 연결된 배포에서는 무시**한다. 데모 배포는 Supabase 자격증명을 넣지 않거나
// demo.supabase 자리표시자를 쓰면 그대로 동작한다.
const demoRequested = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealBackend =
  supabaseUrl.length > 0 && !supabaseUrl.includes("demo.supabase");

export const DEMO = demoRequested && !hasRealBackend;

/** 설정은 데모인데 실백엔드가 붙어 무시된 상태 — 시작 시 한 번 경고하기 위한 플래그. */
export const DEMO_IGNORED = demoRequested && hasRealBackend;
