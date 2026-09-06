import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
const originalSharing = migration("20260829052407_protect_generated_material_sharing.sql");
const helperBoundary = originalSharing.indexOf("create or replace function public.generated_material_share_contract_valid(");
const commonSop = migration("20260829160624_allow_common_sop_generation_evidence.sql");
const quality = migration("20260829163049_protect_generated_material_quality_and_revision.sql");
const endnotes = migration("20260905140458_align_generated_document_endnote_evidence.sql");
const editedSlideCount = migration("20260906010707_align_edited_slide_count.sql");
const generalSource = { document_id: 1, doc: "산악 교육자료", page: 1 };
const sopSource = { document_id: 2, doc: "로프 확보 SOP 123", page: 7 };
const generalLabel = "[산악 교육자료 p.1]";
const sopLabel = "[로프 확보 SOP 123 p.7]";
const repeat = (text: string) => Array.from({ length: 10 }, () => text).join(" ");
const explanation = repeat("대원은 역할별 행동을 수행하고 교관은 단계별 수행 결과를 대원들과 함께 검토한다.");
const safety = repeat("위험요인과 보호구를 점검하고 이상 징후가 있으면 즉시 중단하고 지휘자에게 보고한 뒤 철수한다.");
const evaluation = repeat("평가 체크리스트 기준에 따라 역할별 수행을 관찰하고 누락 없이 정확히 수행하면 통과한다.");
const sopApplication = "[관련 SOP 적용] SOP 123에 따라 로프 확보 작업을 시행한다.";

function evidence() {
  return {
    sources: [generalSource, sopSource], sourceLabels: [generalLabel, sopLabel],
    sopEvidence: { status: "found", sourceLabels: [sopLabel] },
  };
}

function document(kind: "plan" | "lesson") {
  const headings = kind === "plan"
    ? ["훈련목표", "훈련내용", "필요장비", "안전관리", "훈련평가"]
    : ["학습목표", "도입", "핵심이론", "교관시범", "대원실습", "안전유의사항", "정리·평가"];
  return {
    sections: headings.map((heading, index) => ({
      heading,
      content: [
        kind === "plan" && heading === "훈련내용" ? "[도입 · 10분] [실습 · 40분] [평가 · 10분]" : "",
        kind === "lesson" && index > 0 ? `[${heading} · 10분]` : "",
        heading === "훈련내용" || heading === "핵심이론" ? sopApplication : "",
        heading === "안전관리" || heading === "안전유의사항" ? safety
          : heading === "훈련평가" || heading === "정리·평가" ? evaluation : explanation,
      ].filter(Boolean).join(" "),
    })),
    ...evidence(),
  };
}

function slides(count = 10) {
  return {
    ...evidence(),
    slides: Array.from({ length: count }, (_, index) => ({
      title: `로프 확보 교육 ${index + 1}`,
      bullets: [
        "대원은 현장 위험과 보호구를 점검하며 이상 징후가 있으면 중단하고 보고한다.",
        "평가 체크리스트 기준에 따라 수행을 관찰하고 모든 항목을 정확히 수행하면 통과한다.",
      ],
      notes: index === 0 ? sopApplication : "교관은 단계별 수행 결과를 확인한다.",
      sourceRefs: [index === 0 ? sopLabel : generalLabel],
    })),
  };
}

describe("문서 말미 출처 DB 계약", () => {
  it("실제 provenance·SOP·품질 함수로 구형 거절을 재현하고 문서만 허용하면서 보호 조건과 revision을 유지한다", async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create table public.rag_rescue (id text primary key, content text, metadata jsonb, is_active boolean not null default true);
        create table public.documents (id bigint primary key, category text, title text, status text);
        create table public.chunks (id bigint primary key, document_id bigint, page_num integer);
        create table public.generated_materials (
          id bigint generated always as identity primary key, user_id uuid, kind text not null,
          category text, audience text, duration text, topic text, title text not null, content jsonb not null,
          shared boolean not null default false, author_name text, created_at timestamptz default now()
        );
      `);
      // 성공을 반환하는 stub 없이, 운영 SQL의 원문 라벨·출처·주제 판정 함수를 그대로 설치한다.
      expect(helperBoundary).toBeGreaterThan(0);
      await db.exec(originalSharing.slice(0, helperBoundary));
      await db.exec(commonSop);
      await db.exec(quality);
      const corpus = [
        ["general", "로프 확보 작업의 교육과 실습을 다루는 원문", { source: "산악 교육자료.pdf", document_id: "1", page_num: "1", edu_category: "산악", document_type: "training_material" }, true],
        ["sop", "로프 확보 작업의 역할과 위험을 확인하는 원문", { source: "로프 확보 SOP 123.pdf", document_id: "2", page_num: "7", edu_category: "현장지휘·공통", document_type: "sop" }, true],
        ["other", "로프 확보 작업을 다루는 타 분야 원문", { source: "화재 교범.pdf", document_id: "3", page_num: "2", edu_category: "화재", document_type: "training_material" }, true],
        ["inactive", "로프 확보 작업을 다루는 비활성 원문", { source: "비활성 교범.pdf", document_id: "4", page_num: "2", edu_category: "산악", document_type: "training_material" }, false],
      ];
      for (const row of corpus) await db.query(
        "insert into public.rag_rescue(id, content, metadata, is_active) values ($1, $2, $3::jsonb, $4)",
        [row[0], row[1], JSON.stringify(row[2]), row[3]],
      );
      const inspect = async (kind: string, content: unknown) => (await db.query<{ core: boolean; share: boolean }>(`
        select public.generated_material_core_quality_valid($1, '산악', '일반 대원', '1시간', '로프 확보', '로프 확보 교육', $2::jsonb) as core,
          public.generated_material_share_contract_valid($1, '산악', '일반 대원', '1시간', '로프 확보', '로프 확보 교육', $2::jsonb) as share
      `, [kind, JSON.stringify(content)])).rows[0];
      const insert = async (kind: string, content: unknown) => db.query<{ id: number; revision: number }>(`
        insert into public.generated_materials(kind, category, audience, duration, topic, title, content)
        values ($1, '산악', '일반 대원', '1시간', '로프 확보', '로프 확보 교육', $2::jsonb) returning id, revision
      `, [kind, JSON.stringify(content)]);

      for (const kind of ["plan", "lesson"] as const) {
        expect(await inspect(kind, document(kind)), `구형 ${kind}의 인라인 출처 요구`).toEqual({ core: false, share: false });
        await expect(insert(kind, document(kind))).rejects.toThrow(/generated_material_core_quality_invalid/);
      }
      expect(await inspect("slides", slides()), "기존 슬라이드 계약 대조군").toEqual({ core: true, share: true });

      await db.exec(endnotes);
      await db.exec(endnotes); // 반복 적용에도 함수·권한·트리거 계약이 유지되어야 한다.
      expect((await inspect("slides", slides(13))).core, "기존 DB는 1시간 13장을 거절").toBe(false);
      await db.exec(editedSlideCount);
      await db.exec(editedSlideCount);
      for (const count of [6, 13, 20]) {
        expect(await inspect("slides", slides(count)), `1시간 편집본 ${count}장`).toEqual({ core: true, share: true });
        expect((await insert("slides", slides(count))).rows[0].revision).toBe(1);
      }
      for (const count of [5, 21]) {
        expect((await inspect("slides", slides(count))).core, `${count}장 범위 밖`).toBe(false);
        await expect(insert("slides", slides(count))).rejects.toThrow(/generated_material_core_quality_invalid/);
      }
      for (const stepCount of [2, 3, 5]) {
        const comparison = {
          ...slides(13),
          slides: slides(13).slides.map((slide, index) => index === 1 ? {
            ...slide, composition: "comparison",
            steps: ["정상 상태", "이상 상태", "중단 보고", "교관 확인", "재개 판단"].slice(0, stepCount),
          } : slide),
        };
        expect(await inspect("slides", comparison), `편집 비교 기준·단계 ${stepCount}개 DB 저장 계약`).toEqual({ core: true, share: true });
        expect((await insert("slides", comparison)).rows[0].revision).toBe(1);
      }
      for (const kind of ["plan", "lesson"] as const) {
        const content = document(kind);
        expect(content.sections.every(section => !section.content.includes(sopLabel) && !section.content.includes(generalLabel))).toBe(true);
        expect(await inspect(kind, content), `말미 출처 ${kind}`).toEqual({ core: true, share: true });
        const saved = (await insert(kind, content)).rows[0];
        expect(saved.revision).toBe(1);
        const updated = await db.query<{ revision: number }>(
          "update public.generated_materials set title = '개정 교육' where id = $1 and revision = 1 returning revision", [saved.id],
        );
        expect(updated.rows).toEqual([{ revision: 2 }]);
        const stale = await db.query("update public.generated_materials set title = '오래된 편집' where id = $1 and revision = 1 returning id", [saved.id]);
        expect(stale.rows).toEqual([]);
      }

      const replaceGeneral = (replacement: typeof generalSource) => ({
        ...document("plan"), sources: [replacement, sopSource],
        sourceLabels: [`[${replacement.doc} p.${replacement.page}]`, sopLabel],
      });
      const invalidDocuments: Array<[string, ReturnType<typeof document>]> = [
        ["위조 원본", replaceGeneral({ document_id: 999, doc: "위조 교범", page: 1 })],
        ["비활성 원본", replaceGeneral({ document_id: 4, doc: "비활성 교범", page: 2 })],
        ["다른 분야 원본", replaceGeneral({ document_id: 3, doc: "화재 교범", page: 2 })],
        ["목록에 없는 라벨", { ...document("plan"), sourceLabels: [generalLabel, "[위조 SOP p.7]"] }],
      ];
      for (const [name, transform] of [
        ["지정 SOP 적용 위치 누락", (text: string) => text.replace("[관련 SOP 적용]", "")],
        ["위조 인라인 출처", (text: string) => `${text} [위조자료 p.1]`],
        ["없는 SOP 번호", (text: string) => text.replace("SOP 123", "SOP 7")],
        ["없는 SOP 명칭", (text: string) => text.replace("SOP 123", "“허구 로프 절차” SOP")],
        ["시간 표식 누락", (text: string) => text.replace(/\[(?:도입|실습|평가) · \d+분\]/g, "")],
      ] as const) {
        const content = document("plan");
        content.sections[1].content = transform(content.sections[1].content);
        invalidDocuments.push([name, content]);
      }
      for (const [name, index] of [["안전 기준 누락", 3], ["평가 기준 누락", 4]] as const) {
        const content = document("plan");
        content.sections[index].content = repeat("대원은 역할별 행동을 수행하고 교관은 교육 과정을 상세하게 설명한다.");
        invalidDocuments.push([name, content]);
      }
      for (const [name, content] of invalidDocuments) {
        expect((await inspect("plan", content)).core, name).toBe(false);
        await expect(insert("plan", content), name).rejects.toThrow(/generated_material_core_quality_invalid/);
      }

      const deck = slides();
      expect(await inspect("slides", deck), "같은 장의 SOP 출처 유지").toEqual({ core: true, share: true });
      const wrongSlide = slides();
      wrongSlide.slides[0].sourceRefs = [generalLabel];
      wrongSlide.slides[1].sourceRefs = [sopLabel];
      expect(await inspect("slides", wrongSlide), "다른 장의 SOP 출처로 대신할 수 없음").toEqual({ core: false, share: false });
      const editedWrongSlide = slides(13);
      editedWrongSlide.slides[0].sourceRefs = [generalLabel];
      editedWrongSlide.slides[1].sourceRefs = [sopLabel];
      expect(await inspect("slides", editedWrongSlide), "13장 편집본에서도 동일 장 SOP 보호 유지").toEqual({ core: false, share: false });
      await expect(insert("slides", editedWrongSlide)).rejects.toThrow(/generated_material_core_quality_invalid/);

      await db.exec("update public.rag_rescue set is_active = false where id = 'sop'");
      expect(await inspect("plan", document("plan")), "활성 SOP 조건 재검사").toEqual({ core: false, share: false });
      expect(await inspect("slides", slides(13)), "13장 편집본도 비활성 SOP를 거절").toEqual({ core: false, share: false });
      await db.exec("update public.rag_rescue set is_active = true where id = 'sop'");
      // 라벨·출처는 그대로 두고 본문만 바꿔 실제 주제 판정 함수가 거절하는지 분리한다.
      await db.exec("update public.rag_rescue set content = '다른 기구의 보관' where id = 'sop'");
      const provenance = await db.query<{ valid: boolean }>(
        "select public.generated_material_source_provenance_valid($1::jsonb, '산악') as valid", [JSON.stringify(sopSource)],
      );
      expect(provenance.rows).toEqual([{ valid: true }]);
      expect((await inspect("plan", document("plan"))).share, "파일명만 주제가 맞아도 본문 주제 근거가 없으면 거절").toBe(false);

      const privileges = await db.query<{ role: string; function_name: string; allowed: boolean }>(`
        select role, function_name, has_function_privilege(role, function_name || '(text,text,text,text,text,text,jsonb)', 'execute') as allowed
        from unnest(array['anon','authenticated']) as roles(role)
        cross join unnest(array['public.generated_material_core_quality_valid','public.generated_material_share_contract_valid']) as functions(function_name)
      `);
      expect(privileges.rows).toHaveLength(4);
      expect(privileges.rows.every(row => !row.allowed)).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        try {
          for (const name of ["generated_material_core_quality_valid", "generated_material_share_contract_valid"]) {
            await expect(db.query(
              `select public.${name}('plan', '산악', '일반 대원', '1시간', '로프 확보', '교육', $1::jsonb)`,
              [JSON.stringify(document("plan"))],
            )).rejects.toThrow(/permission denied for function/);
          }
        } finally { await db.exec("reset role"); }
      }
    } finally { await db.close(); }
  });
});
