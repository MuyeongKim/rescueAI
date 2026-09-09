import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rescueai-app-env-"));
  temporaryRoots.push(root);
  for (const directory of ["scripts/lib", "config", "node_modules/next/dist/bin"]) mkdirSync(join(root, directory), { recursive: true });
  for (const file of ["scripts/run-app.mjs", "scripts/lib/database-environment.mjs"]) {
    writeFileSync(join(root, file), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  writeFileSync(join(root, "config/database-environments.json"), JSON.stringify({ productionProjectRefs: ["productionexample"], developmentProjectRefs: ["developmentexample"] }));
  writeFileSync(join(root, "node_modules/next/dist/bin/next"), `console.log(JSON.stringify({ url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, aiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY, hwpKey: process.env.HWP_WRITER_API_KEY, embeddingUrl: process.env.EMBEDDING_API_URL, command: process.argv[2] }));`);
  return root;
}

describe("앱 실행의 실제 환경 전달", () => {
  it("개발 파일만 읽고 미설정 키를 비워 Next의 운영 .env.local 폴백을 막는다", () => {
    const root = fixture();
    writeFileSync(join(root, ".env.development.local"), "RESCUEAI_DATABASE_ENV=development\nNEXT_PUBLIC_SUPABASE_URL=https://developmentexample.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=synthetic-dev-key\n");
    writeFileSync(join(root, ".env.local"), "GOOGLE_GENERATIVE_AI_API_KEY=synthetic-production-key\nHWP_WRITER_API_KEY=synthetic-production-hwp\nEMBEDDING_API_URL=https://production-embedding.example.invalid\n");
    const result = spawnSync(process.execPath, [join(root, "scripts/run-app.mjs"), "build"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ url: "https://developmentexample.supabase.co", serviceKey: "synthetic-dev-key", aiKey: "", hwpKey: "", embeddingUrl: "", command: "build" });
  });
  it("운영 URL이 들어오면 Next 프로세스를 실행하기 전에 종료한다", () => {
    const root = fixture();
    const result = spawnSync(process.execPath, [join(root, "scripts/run-app.mjs"), "dev"], { encoding: "utf8", env: { PATH: process.env.PATH, NEXT_PUBLIC_SUPABASE_URL: "https://productionexample.supabase.co", RESCUEAI_DATABASE_ENV: "development" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("운영 DB 연결을 차단");
  });
});
