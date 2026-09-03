// 뉴스 기사 → 한국어 요약 + 지역/분야 분류 (AI). 관리자 "AI 요약"(A)·자동수집(B) 공용.
import { generateObject } from "ai";
import { z } from "zod";
import { getChatModel } from "@/lib/llm";

const schema = z.object({
  summary: z.string(), // 2~3문장 한국어 요약
  region: z.enum(["전국", "해외"]),
  category: z.string(), // 수난/화재/산악/구급/드론/구조일반 등
});

export type Summarized = { summary: string; region: string; category: string };

// 자동수집(B)용 — 헤드라인 여러 개를 한 번의 호출로 요약/분류(비용·지연 절감).
const batchSchema = z.object({
  items: z.array(
    z.object({
      summary: z.string(),
      region: z.enum(["전국", "해외"]),
      category: z.string(),
    })
  ),
});

export async function summarizeHeadlines(
  headlines: { title: string; source?: string }[]
): Promise<Summarized[]> {
  if (headlines.length === 0) return [];
  try {
    const listed = headlines
      .map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ""}`)
      .join("\n");
    const { object } = await generateObject({
      model: getChatModel(),
      schema: batchSchema,
      temperature: 0.2,
      prompt: `아래 소방·구조 관련 뉴스 헤드라인들을 각각 한국어로 처리해 **입력과 같은 순서·개수**로 반환하세요.
- summary: 헤드라인 기준 1~2문장 한국어 요약(해외면 번역).
- region: 국내면 "전국", 해외면 "해외".
- category: 분야 한 단어(수난/화재/산악/구급/드론/붕괴·매몰/구조일반 중).

헤드라인:
${listed}`,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    return object.items;
  } catch (e) {
    console.error("[news-ai] 배치 요약 실패:", e);
    return [];
  }
}

export async function summarizeArticle(input: {
  title: string;
  text?: string;
  source?: string;
}): Promise<Summarized | null> {
  try {
    const { object } = await generateObject({
      model: getChatModel(),
      schema,
      temperature: 0.2,
      prompt: `다음은 소방·구조 관련 기사입니다. 구조대원이 빠르게 파악하도록 한국어로 처리하세요.
- summary: 핵심을 2~3문장으로 요약(해외 기사면 한국어로 번역·요약).
- region: 국내 사안이면 "전국", 해외 사안이면 "해외".
- category: 분야 한 단어(수난/화재/산악/구급/드론/붕괴·매몰/구조일반 중 가장 가까운 것).

제목: ${input.title}
출처: ${input.source ?? "-"}
내용: ${(input.text ?? "").slice(0, 4000)}`,
      // Gemini 사고 끄기(지연↓). 타 제공자는 무시됨. GLM 요청은 lib/llm에서 버전별로 보정.
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    return object;
  } catch (e) {
    console.error("[news-ai] 요약 실패:", e);
    return null;
  }
}
