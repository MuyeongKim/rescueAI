// AI 자료제작 3주 시범운영 회귀평가 런처.
// 실제 검색·동기 생성은 앱 lib, jobs 모드는 실제 사용자 세션의 HTTP 경로를 사용해
// 운영 파이프라인을 복제하지 않는다.
import { spawnSync } from "node:child_process";

const mode = process.argv[2] || "contract";
const allowedModes = new Set(["contract", "rag", "generation", "jobs", "all"]);
if (!allowedModes.has(mode)) {
  console.error("사용법: node eval/run-material-generation-pilot.mjs [contract|rag|generation|jobs|all]");
  process.exit(2);
}

const env = { ...process.env };
// 이전 셸·CI 단계에 남은 통합평가 플래그가 contract 모드까지 비용을 발생시키지 않게
// 선택 모드를 단일 출처로 삼아 매 실행마다 먼저 초기화한다.
delete env.RUN_MATERIAL_PILOT_RAG;
delete env.RUN_MATERIAL_PILOT_GENERATION;
delete env.RUN_MATERIAL_PILOT_JOBS;
if (mode === "rag" || mode === "all") env.RUN_MATERIAL_PILOT_RAG = "1";
if (mode === "generation" || mode === "all") {
  env.RUN_MATERIAL_PILOT_GENERATION = "1";
}
if (mode === "jobs") env.RUN_MATERIAL_PILOT_JOBS = "1";

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "tests/material-generation-pilot.integration.test.ts",
    "tests/material-generation-jobs.integration.test.ts",
    "--reporter=verbose",
  ],
  { stdio: "inherit", env },
);

process.exit(result.status ?? 1);
