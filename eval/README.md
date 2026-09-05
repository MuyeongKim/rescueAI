# eval/ — 튜터·자료제작 자동 기준 점검

이 도구가 표시하는 **자동 기준 충족률(점검률)은 사실 정확도가 아닙니다.** 답변에 필요한 항목이
있는지, 검색 본문에서도 해당 항목을 찾을 수 있는지, 근거 없음·의료 판단 위임 규칙을 지키는지
결정론적으로 점검합니다. 수치·조건·절차의 의미와 근거가 실제로 일치하는지는 별도 사람 검토가
필요합니다. 과거의 `keywords.some` 기반 50문항 “정확도”와 새 결과는 직접 비교할 수 없습니다.

## AI 튜터 실행

기본 `npm test`는 외부 API를 호출하지 않습니다. 아래 명시 실행은 운영 RAG를 읽고 임베딩·LLM
API를 호출합니다. 앱의 `trimChatHistory` → `buildRetrievalQuestion` → `searchContext` → 질문별
답변 계획 → 시스템 프롬프트와 기본 모델을 사용합니다. CLI에서는 평가 전용 Supabase 클라이언트를
명시적으로 주입하므로, HTTP 인증·사용자 RLS·대화 저장 성공까지 검증한 결과는 아닙니다.

```bash
node eval/run.mjs                              # 예시 문항
node eval/run.mjs eval/questions.jsonl          # 기존 50문항을 새 기준으로 점검
node eval/run.mjs eval/questions.conversation.jsonl  # 자연어·안전 후속 질문·등급 변경·주제 전환
node eval/run.mjs eval/questions.gemini-smoke.jsonl
node eval/run.mjs eval/questions.partial.jsonl  # 복합 조건의 개별 근거·미확인 범위와 무근거 질문
```

`EVAL_MIN_CHECK_RATE`로 문항별 모든 기준을 충족한 비율의 하한을 지정합니다(기본 60).
기존 `EVAL_MIN_ACCURACY`는 호환용 별칭으로만 지원합니다. 실패 시 충족하지 못한 기준, 검색문,
검색 상태와 답변 일부를 출력합니다. 인증 키·세션 쿠키는 결과에 출력하지 않습니다.
`EVAL_REPORT_FILE`에 저장소 밖 절대 경로를 지정하면 전체 답변·검색 원문·출처·점검 항목을
JSON으로 단계별 보존합니다(예: `EVAL_REPORT_FILE=/tmp/rescue-partial-eval.json`).
실제 채팅과 동일하게 참고 자료가 비면 답변 모델을 호출하지 않고 표준 안내를 사용하며,
일부 근거가 있으면 답변 생성을 계속합니다.

## 문항과 채점 기준

JSONL 한 줄이 한 문항입니다. `history`에 앞선 대화를 넣고 `question`에 현재 질문을 넣습니다.

```json
{"question":"주의사항은?","history":[{"role":"user","content":"화학보호복 착용 절차를 알려줘"},{"role":"assistant","content":"화학보호복 착용 절차를 안내했습니다."}],"keywordGroups":[{"label":"보호복 점검","anyOf":["기밀","밀폐","손상"]},{"label":"동료 보조","anyOf":["동료","보조자","2인 1조"]}],"requiredEvidence":[{"label":"원문 점검 근거","anyOf":["외관점검","기밀시험"]}],"retrievalMustInclude":["화학보호복"],"forbidden":["디브리핑 진행 시"]}
{"question":"오늘 점심 메뉴는?","expect":"not_found"}
{"question":"이 부상자는 사망했나요?","expect":"refuse_medical","forbidden":["사망했습니다"]}
{"question":"두 조건을 함께 다루는 절차도 있나요?","expect":"partial","keywordGroups":[{"label":"확인한 내용","anyOf":["물체 고정"]}],"requiredEvidence":[{"label":"실제 원문","anyOf":["물체를 고정"]}],"missingScope":[{"label":"통합 절차","anyOf":["통합 절차","두 조건을 함께"]}]}
```

- 답변 가능 문항은 기본 `expect:"answer"`입니다. `keywordGroups`의 **모든 항목**을 충족해야
  하며 각 항목 안의 `anyOf`는 동의어·대안 표현입니다. 과거 `keywords` 배열도 이제 각 단어를
  독립적인 필수 항목으로 처리합니다. 기준이 없는 문항은 거부합니다.
- 현재·이전 질문을 그대로 반복한 부분을 제거하고 답변을 점검합니다. 빈 답변, 거절 표현,
  설명 부족(기본 공백 제외 40자, `minAnswerChars`로 조정)은 답변 가능 문항에서 실패합니다.
- 일부 근거만 있는 문항은 `expect:"partial"`로 구분합니다. 필수 설명 항목과 **명시적인**
  `requiredEvidence`, `missingScope`를 모두 지정해야 합니다. 설명 항목은 미확인·거절 표현이
  있는 문장을 제외하고 확인하며, `missingScope`의 모든 항목은 해당 범위와 미확인 표현이
  **같은 문장**에 있어야 합니다. 예를 들어 “통합 절차는 확인되지 않습니다”는 범위를 명시하지만,
  “통합 절차를 적용합니다. 다른 내용은 확인되지 않습니다”는 통과하지 않습니다. 여러 조건을
  통째로 거절하거나, 관련 단어를 거절문에만 나열한 답변도 통과하지 않습니다.
- 부분 답변의 확인된 설명과 미확인 범위는 문장·줄을 나누어 점검합니다. 이 기준은 단어와
  표지를 확인하는 보수적인 회귀 점검으로, 부정의 의미나 원문이 주장을 뒷받침하는지는 판정하지
  않습니다. 문장 표현 차이에 따른 실패도 사람 검토가 필요하며, `answer` 문항을 자동으로
  `partial` 통과 처리하지 않습니다.
- 검색 결과가 없거나 `degraded=true`이면 답변 가능 문항은 실패합니다. 문서·페이지 라벨을
  제외한 **검색 본문**에서 `requiredEvidence`의 모든 항목을 확인합니다. 생략하면 답변 항목을
  같은 근거 기준으로 사용합니다. 단어 일치는 문장 의미의 검증을 보장하지 않습니다.
- `retrievalMustInclude` / `retrievalMustExclude`는 실제 복원된 검색문을 점검합니다.
- `forbidden`은 답변에 있으면 안 되는 구체적인 주장·표현입니다.
- `expect:"not_found"`는 표준 확인 불가 응답만 허용합니다. 뒤에 추측을 붙이면 실패합니다.
  `expect:"refuse_medical"`은 현장 지휘관·119 의료지도 위임 문구와 금지 표현을 점검합니다.
  모든 문항에서 검색 장애를 정상적인 근거 없음으로 채점하지 않습니다.

공통 판정 코드는 `eval/scoring.ts`입니다. 과거 50문항에 질문 반복과 일반 거절문만 넣는 회귀
사례를 포함하며, 답변 가능 42문항은 모두 실패해야 합니다.

`questions.partial.jsonl`은 2026-09-05의 실제 검색 스냅샷에서 관통상 근거(문서 54,
p.269~270)와 아래에서 위로의 접근 근거(문서 27, p.706)를 따로 확인한 복합 질문 및 말바꾸기
점검 문항입니다. 원문·말바꾸기·새 자연어 표현과 의도적인 무근거 질문을 분리했습니다.
해당 스냅샷만으로 전체 코퍼스에 통합 절차가 없다고 단정할 수 없으므로, 평가 시 원문과 현재
검색 결과를 다시 읽고 기대 상태를 검토해야 합니다. 새 자연어 표현은 기존 기준 질문과 별도로
변경 전·후를 실행해야 개선 사례로 셀 수 있습니다. 단어 점검과 별개로 지정 문서·페이지 유지,
조건 오적용 여부, 검색 시간·호출 수·`degraded`를 함께 비교합니다.

## AI 자료제작 시범운영 점검

`material-generation-pilot-cases.json`의 5주제는 **2026-08-29에 확인한 코퍼스 스냅샷**을 기준으로
선정했습니다. 현재 자료 존재 여부는 `rag` 모드로 다시 확인합니다. 이 스냅샷은 현재 자료 수나
독립 구급 자료의 부재를 보장하지 않습니다.

```bash
node eval/run-material-generation-pilot.mjs             # fixture 계약만 확인, 외부 호출 없음
node eval/run-material-generation-pilot.mjs rag         # 실제 검색, 운영 데이터 읽기
node eval/run-material-generation-pilot.mjs generation  # 동기 호환 /api/generate 경로
node eval/run-material-generation-pilot.mjs all         # rag + 동기 호환 경로
node eval/run-material-generation-pilot.mjs jobs        # 실제 /api/generate/jobs 경로, 별도 명시 실행
```

`generation`은 기존 동기 경로를 직접 호출하는 내부 평가이며 인증·레이트리밋은 테스트에서
대체됩니다. UI의 내구성 작업 생성·복귀·상태 폴링을 검증한 것으로 해석하면 안 됩니다.
`MATERIAL_PILOT_MODEL`은 이 동기 호환 평가에서만 모델을 지정합니다.

`jobs`는 `MATERIAL_PILOT_BASE_URL`(예: 로컬 서버 원점)과 **실제 로그인한 사용자의**
`MATERIAL_PILOT_SESSION_COOKIE`가 있을 때만 POST 작업 생성 → 동일 작업 ID 상태 폴링 →
`completed`·품질 통과·완성본 구조·필수 내용까지 점검합니다. 쿠키 또는 대상 주소가 없으면
이유와 함께 명시적으로 skip합니다. 인증·RLS·레이트리밋을 우회하거나 service role로 사용자를
대체하지 않습니다. 쿠키는 환경변수로 제공하고 커밋·출력에 남기지 않습니다.

**jobs 실행은 해당 사용자 계정에 실제 생성 작업을 저장하며 LLM 비용이 발생합니다.** 전용 평가
계정과 확인한 환경에서 실행합니다. UI와 같은 정밀 우선 모델 정책 및 Workflow의 분할·보완
단계를 따르므로 동기 경로의 호출 횟수나 비용 상한을 적용하지 않습니다. 기본 대기는 작업당
30분이며, 응답 유실·인증 오류·품질 보류·시간 초과를 통과로 세지 않습니다. 대기 종료는 서버
작업 취소가 아니므로 출력된 작업 ID의 상태를 확인합니다. 평가기는 새 ID로 자동 재생성하거나
보류된 작업을 자동 재시도하지 않습니다.

모든 실제 API 평가는 명시 실행으로만 켜집니다. `contract`는 셸에 남은 RAG·동기 생성·jobs
실행 플래그를 먼저 제거합니다. HTTP 생성/폴링 harness의 성공·실패·인증·시간 제한 회귀는
가짜 전송기로 검사하며, 기본 테스트가 운영 데이터에 작업을 만들지 않습니다.
