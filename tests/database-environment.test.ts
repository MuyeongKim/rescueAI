import { describe, expect, it } from "vitest";
// @ts-expect-error Pure configuration helper also runs directly in Node before Next compilation.
import { assertDatabaseEnvironment } from "../scripts/lib/database-environment.mjs";

const registry = { productionProjectRefs: ["productionexample"], developmentProjectRefs: ["developmentexample"] };
const productionUrl = "https://productionexample.supabase.co";
const developmentUrl = "https://developmentexample.supabase.co";

describe("개발·운영 데이터베이스 분리", () => {
  it("NODE_ENV나 개발 표시를 바꿔도 로컬 실행의 운영 DB 연결을 차단한다", () => {
    for (const NODE_ENV of ["development", "production"]) {
      expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: productionUrl, NODE_ENV, RESCUEAI_DATABASE_ENV: "development" }, registry)).toThrow("운영 DB 연결을 차단");
    }
  });
  it("미리보기 배포가 운영 DB 자격증명을 재사용하지 못한다", () => {
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: productionUrl, VERCEL_ENV: "preview", RESCUEAI_DATABASE_ENV: "development" }, registry)).toThrow("운영 DB 연결을 차단");
  });
  it("등록된 개발 프로젝트와 명시적으로 선택한 로컬 DB를 허용한다", () => {
    for (const NEXT_PUBLIC_SUPABASE_URL of [developmentUrl, "http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]) {
      expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL, RESCUEAI_DATABASE_ENV: "development" }, registry)).not.toThrow();
    }
  });
  it("다른 프로젝트나 누락된 환경 구분으로 우회하지 못한다", () => {
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: developmentUrl }, registry)).toThrow("개발 DB 확인");
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://unknownproject.supabase.co", RESCUEAI_DATABASE_ENV: "development" }, registry)).toThrow("등록되지 않은 개발 DB");
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://developmentexample.supabase.co", RESCUEAI_DATABASE_ENV: "development" }, registry)).toThrow("HTTPS");
  });
  it("운영 배포는 등록된 운영 DB로만 연결한다", () => {
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: productionUrl, VERCEL_ENV: "production" }, registry)).not.toThrow();
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: developmentUrl, VERCEL_ENV: "production" }, registry)).toThrow("운영 배포의 DB");
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: productionUrl.replace("https:", "http:"), VERCEL_ENV: "production" }, registry)).toThrow("HTTPS");
  });
  it("실제 DB가 붙은 데모 플래그로 환경 검사를 우회하지 못한다", () => {
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_DEMO_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: productionUrl }, registry)).toThrow("운영 DB 연결을 차단");
    expect(() => assertDatabaseEnvironment({ NEXT_PUBLIC_DEMO_MODE: "1" }, registry)).not.toThrow();
  });
});
