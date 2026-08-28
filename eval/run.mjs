// 평가셋 러너 런처 (PRD §11 M9, AC-11) — 정확도 측정용 오프라인 도구.
//
// 실제 검색·답변 로직은 앱과 동일한 lib 코드(쿼리 확장 → 운영 임베딩 → match_rag_rescue
// 하이브리드 검색 → LLM 재순위 → Gemini 답변)를 그대로 호출해야 정확하다.
// 그 코드는 TypeScript(@/lib/*)라 standalone .mjs 에서 직접 import 할 수 없으므로,
// 이 스크립트는 동일 코드를 import 하는 vitest 통합 러너(tests/eval-run.integration.test.ts)에
// 위임한다. 파이프라인 로직의 단일 출처를 유지하기 위함(중복 구현 금지).
//
// 실행 (프로젝트 루트에서):
//   node eval/run.mjs                      # 예시셋(eval/questions.example.jsonl)
//   node eval/run.mjs eval/questions.jsonl # 실제 50문항
//
// 문항 형식·채점 방식은 eval/README.md 참고.
import { spawnSync } from "node:child_process";

const file = process.argv[2] || "eval/questions.example.jsonl";

const res = spawnSync(
  "npx",
  ["vitest", "run", "tests/eval-run.integration.test.ts", "--reporter=verbose"],
  {
    stdio: "inherit",
    env: { ...process.env, RUN_INTEGRATION: "1", EVAL_FILE: file },
  }
);

process.exit(res.status ?? 1);
