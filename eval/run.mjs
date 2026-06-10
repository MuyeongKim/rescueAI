// 평가셋 러너 (PRD §11 M9, AC-11) — 정확도 측정용 오프라인 스크립트.
//
// 실행 (Node 20.6+; 프로젝트 루트에서):
//   node --env-file=.env.local eval/run.mjs eval/questions.jsonl
//
// questions.jsonl 각 줄(JSON):
//   {"question":"...", "category":"산악|null", "keywords":["..."]}        // 키워드 포함 여부로 채점
//   {"question":"...", "expect":"not_found"}                              // "확인되지 않습니다" 응답 기대
//   {"question":"...", "expect":"refuse_medical"}                         // 119 의료지도 안내 기대
//
// 채점은 휴리스틱(키워드/문구 포함)입니다. 애매한 항목은 사람이 최종 판단하세요.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const NOT_FOUND = "관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요.";
const DIM = 1024;

const file = process.argv[2] || "eval/questions.example.jsonl";
const lines = readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
const items = lines.map((l) => JSON.parse(l));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

async function embed(text) {
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const res = await openai.embeddings.create({ model, input: text, dimensions: DIM });
  return "[" + res.data[0].embedding.join(",") + "]";
}

function buildSystemPrompt(contextText) {
  const ref = contextText.trim().length > 0 ? contextText : "(관련 자료가 검색되지 않았습니다.)";
  return `당신은 전북소방본부 구조대원을 돕는 AI 어시스턴트입니다.

[답변 규칙]
1. 아래 '참고 자료'에 있는 내용만 근거로 답변하세요.
2. 참고 자료에 근거가 없으면 추측하지 말고 정확히 이렇게 답하세요:
   "${NOT_FOUND}"
3. 부상자 생사 판단 등 의학적·법적 판단은 하지 말고,
   "현장 지휘관 또는 119 의료지도에 문의하세요" 라고 안내하세요.
4. 답변은 한국어로, 구조대원이 현장에서 빠르게 읽도록 간결하게 작성하세요.
5. 답변 끝에는 근거가 된 자료를 표시하세요.

[참고 자료]
${ref}`;
}

async function answer(q) {
  const emb = await embed(q.question);
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: q.question,
    query_embedding: emb,
    match_count: 5,
    filter_category: q.category || null,
  });
  if (error) console.error("  rpc error:", error.message);
  const rows = data || [];
  const context = rows
    .map((r) => `[${r.doc_title} p.${r.page_num ?? "-"}]\n${r.content}`)
    .join("\n\n---\n\n");
  const { text } = await generateText({
    model: anthropic(MODEL),
    system: buildSystemPrompt(context),
    prompt: q.question,
    temperature: 0.2,
  });
  return text;
}

function score(q, text) {
  if (q.expect === "not_found") return text.includes("확인되지 않습니다");
  if (q.expect === "refuse_medical")
    return /119 의료지도|현장 지휘관/.test(text);
  const kws = q.keywords || [];
  if (kws.length === 0) return true;
  return kws.some((k) => text.includes(k));
}

async function main() {
  let pass = 0;
  console.log(`평가 시작: ${items.length}문항 (${file})\n`);
  for (let i = 0; i < items.length; i++) {
    const q = items[i];
    try {
      const text = await answer(q);
      const ok = score(q, text);
      if (ok) pass++;
      console.log(`[${i + 1}/${items.length}] ${ok ? "✓" : "✗"} ${q.question}`);
      if (!ok) console.log(`    답변: ${text.slice(0, 120).replace(/\n/g, " ")}…`);
    } catch (e) {
      console.log(`[${i + 1}/${items.length}] ✗ (오류) ${q.question}: ${e.message}`);
    }
  }
  const acc = items.length ? Math.round((pass / items.length) * 100) : 0;
  console.log(`\n정확도: ${pass}/${items.length} = ${acc}%  (목표 60% 이상)`);
}

main();
