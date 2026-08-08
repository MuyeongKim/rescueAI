// supabase/migrations/*.sql 를 순서대로 이어붙여 supabase/setup_new_project.sql 을 만든다.
//
// 왜: 새 프로젝트 부트스트랩 SQL 을 손으로 관리하다 마이그레이션과 어긋났었다
//     (generated_materials·popular_questions·공유 컬럼이 빠지고, 이미 지운 quiz_attempts 는 남아
//      새 프로젝트를 세우면 AI 자료제작 저장·공유·인기질문이 통째로 죽는 상태였다).
//     이제 마이그레이션이 유일한 출처이고 이 파일은 그 산출물이다.
//
// 사용법: npm run sql:setup   (마이그레이션을 추가/수정한 뒤 반드시 다시 실행)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const outPath = join(root, "supabase", "setup_new_project.sql");

// 파일명 정렬 = 적용 순서. 0001~0012(레거시) 가 먼저, 그 뒤 YYYYMMDDHHMMSS_ 형식이 온다.
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("마이그레이션 파일을 찾지 못했습니다:", migrationsDir);
  process.exit(1);
}

const header = `-- ⚠️ 자동 생성 파일 — 직접 수정하지 마세요.
--    출처: supabase/migrations/*.sql  ·  재생성: npm run sql:setup
--
-- 새 Supabase 프로젝트를 세울 때 이 파일 전체를 SQL Editor 에 붙여 한 번에 실행하세요.
-- 마이그레이션을 순서대로 이어붙인 것이라, 기존 프로젝트에 개별 마이그레이션을 적용한 결과와
-- 동일한 스키마가 됩니다. (중간에 만들었다가 지우는 테이블이 보이는 것은 정상 — 이력 그대로입니다.)
--
-- 포함된 마이그레이션 ${files.length}개:
${files.map((f) => `--   · ${f}`).join("\n")}
`;

const body = files
  .map((f) => {
    const sql = readFileSync(join(migrationsDir, f), "utf-8").trimEnd();
    return [
      "",
      "-- " + "=".repeat(76),
      `-- ${f}`,
      "-- " + "=".repeat(76),
      "",
      sql,
      "",
    ].join("\n");
  })
  .join("\n");

writeFileSync(outPath, `${header}${body}\n`, "utf-8");
console.log(`생성 완료: supabase/setup_new_project.sql (마이그레이션 ${files.length}개)`);
