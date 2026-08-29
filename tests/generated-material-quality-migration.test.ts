import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260829163049_protect_generated_material_quality_and_revision.sql"
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const SETUP_SQL = readFileSync(
  resolve(process.cwd(), "supabase/setup_new_project.sql"),
  "utf8"
);

const SOURCE_LABEL = "[현장 교육자료 p.1]";
const NOT_FOUND_DISCLOSURE =
  "관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.";

function repeated(text: string, count = 8): string {
  return Array.from({ length: count }, () => text).join(" ");
}

function validPlanContent() {
  return {
    sections: [
      {
        heading: "훈련목표",
        content: repeated("대원은 현장 위험을 판단하고 역할에 따라 안전하게 대응한다."),
      },
      {
        heading: "훈련내용",
        content: `[도입 · 20분] 조건을 확인한다. [이론 · 20분] 판단 기준을 설명한다. [시범 · 20분] 교관 동작을 관찰한다. [실습 · 40분] 역할별 절차를 반복한다. [평가 · 20분] 결과를 확인한다. ${NOT_FOUND_DISCLOSURE} ${SOURCE_LABEL} ${repeated("교관은 역할별 확인 결과를 질문하고 대원은 판단 근거와 수행 결과를 서로 교차 확인한다.", 3)}`,
      },
      {
        heading: "필요장비",
        content: repeated(`보호장비와 통신장비의 수량과 손상을 점검한다. ${SOURCE_LABEL}`),
      },
      {
        heading: "안전관리",
        content: repeated(
          `위험요인을 확인하고 보호구와 안전구역을 점검한다. 이상 징후가 있으면 즉시 훈련을 중단하고 지휘자에게 보고한 뒤 철수한다. ${SOURCE_LABEL}`
        ),
      },
      {
        heading: "훈련평가",
        content: repeated(
          "평가 체크리스트로 역할과 수행을 관찰한다. 필수 항목을 누락 없이 정확히 수행하면 통과하고 미달 항목은 다시 시연한다."
        ),
      },
    ],
    sources: [{ document_id: 1, doc: "현장 교육자료", page: 1 }],
    sourceLabels: [SOURCE_LABEL],
    sopEvidence: { status: "not_found", sourceLabels: [] },
  };
}

describe("generated_materials DB 핵심 품질·개정 보호", () => {
  it("직접 INSERT/UPDATE 품질 트리거와 내용 변경 전용 revision을 설치한다", () => {
    expect(MIGRATION).toContain("add column if not exists revision bigint not null default 1");
    expect(MIGRATION).toContain("generated_material_core_quality_invalid");
    expect(MIGRATION).toContain("create trigger enforce_generated_material_core_quality");
    expect(MIGRATION).toContain("create trigger set_generated_material_revision");
    expect(MIGRATION).toContain("new.revision := old.revision + 1");
    expect(MIGRATION).toContain("new.revision := old.revision");
  });

  it("통합 setup SQL에서 공통 SOP 계약 뒤에 품질·revision 보호를 적용한다", () => {
    const commonIndex = SETUP_SQL.indexOf(
      "-- 20260829160624_allow_common_sop_generation_evidence.sql"
    );
    const qualityIndex = SETUP_SQL.indexOf(
      "-- 20260829163049_protect_generated_material_quality_and_revision.sql"
    );
    expect(commonIndex).toBeGreaterThan(-1);
    expect(qualityIndex).toBeGreaterThan(commonIndex);
  });

  it("PGlite에서 유효 자료는 저장하고 저품질 직접 쓰기는 거절하며 CAS용 revision을 보존한다", async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create table public.generated_materials (
          id bigint generated always as identity primary key,
          user_id uuid,
          kind text not null,
          category text,
          audience text,
          duration text,
          topic text,
          title text not null,
          content jsonb not null,
          shared boolean not null default false,
          author_name text,
          created_at timestamptz default now()
        );
        create function public.generated_material_source_provenance_valid(jsonb, text)
        returns boolean language sql stable security definer set search_path = ''
        as $$ select true $$;
        create function public.generated_material_share_contract_valid(
          text, text, text, text, text, text, jsonb
        ) returns boolean language sql volatile security definer set search_path = ''
        as $$ select true $$;
      `);
      await db.exec(MIGRATION);

      const content = validPlanContent();
      const inserted = await db.query<{ id: number; revision: number }>(
        `insert into public.generated_materials(
          kind, category, audience, duration, topic, title, content
        ) values ('plan', '산악', '일반 대원', '2시간', '산악사고 대비', '유효 계획', $1::jsonb)
        returning id, revision`,
        [JSON.stringify(content)]
      );
      expect(inserted.rows).toEqual([{ id: 1, revision: 1 }]);

      const updated = await db.query<{ revision: number }>(
        `update public.generated_materials
         set title = '수정 계획'
         where id = 1 and revision = 1
         returning revision`
      );
      expect(updated.rows).toEqual([{ revision: 2 }]);

      const stale = await db.query(
        `update public.generated_materials
         set title = '오래된 화면의 수정'
         where id = 1 and revision = 1
         returning revision`
      );
      expect(stale.rows).toEqual([]);

      await db.exec(
        `update public.generated_materials set revision = 99, shared = true where id = 1`
      );
      const afterShare = await db.query<{ revision: number }>(
        "select revision from public.generated_materials where id = 1"
      );
      expect(afterShare.rows).toEqual([{ revision: 2 }]);

      const invalid = validPlanContent();
      invalid.sections[3].content = repeated("장비를 준비한다.");
      await expect(
        db.query(
          `insert into public.generated_materials(
            kind, category, audience, duration, topic, title, content
          ) values ('plan', '산악', '일반 대원', '2시간', '산악사고 대비', '저품질 계획', $1::jsonb)`,
          [JSON.stringify(invalid)]
        )
      ).rejects.toThrow(/generated_material_core_quality_invalid/);
    } finally {
      await db.close();
    }
  });
});
