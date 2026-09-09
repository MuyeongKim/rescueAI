/** Project identifiers are public configuration; credentials must stay in environment files. */
export function assertDatabaseEnvironment(env, registry) {
  const value = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const demo = env.NEXT_PUBLIC_DEMO_MODE === "1";
  if (demo && (!value || /^https?:\/\/demo\.supabase(?:\.co)?\/?$/.test(value))) return;
  if (!value) {
    throw new Error("개발 DB가 설정되지 않았습니다. .env.development.local에 별도 개발 DB를 설정해 주세요.");
  }

  let url;
  try { url = new URL(value); } catch {
    throw new Error("Supabase URL 형식을 확인해 주세요.");
  }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Supabase URL에는 사용자 정보 없이 HTTP(S) 주소만 지정해야 합니다.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ref = /^([a-z0-9]+)\.supabase\.(?:co|in)$/.exec(url.hostname)?.[1];
  const production = env.VERCEL_ENV === "production";
  if (!local && url.protocol !== "https:") {
    throw new Error("원격 DB는 HTTPS 주소를 사용해야 합니다.");
  }

  if (production) {
    if (!ref || !registry.productionProjectRefs.includes(ref)) {
      throw new Error("운영 배포의 DB가 등록된 운영 프로젝트와 다릅니다. 배포 설정을 확인해 주세요.");
    }
    return;
  }

  if (ref && registry.productionProjectRefs.includes(ref)) {
    throw new Error("개발·미리보기 실행에서 운영 DB 연결을 차단했습니다. .env.development.local에 별도 개발 DB를 설정해 주세요.");
  }
  if (env.RESCUEAI_DATABASE_ENV !== "development") {
    throw new Error("개발 DB 확인이 필요합니다. RESCUEAI_DATABASE_ENV=development를 별도 개발 환경에 설정해 주세요.");
  }
  if (!local && (!ref || !registry.developmentProjectRefs.includes(ref))) {
    throw new Error("등록되지 않은 개발 DB입니다. config/database-environments.json의 개발 프로젝트 목록을 확인해 주세요.");
  }
}
