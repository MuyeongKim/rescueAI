import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260904222054_improve_tutor_recovery.sql"), "utf8");
const initialSchema = readFileSync(resolve(process.cwd(), "supabase/migrations/0001_init.sql"), "utf8");
const rlsSchema = readFileSync(resolve(process.cwd(), "supabase/migrations/0003_triggers_rls.sql"), "utf8");
const owner = "10000000-0000-4000-8000-000000000001";
const otherOwner = "20000000-0000-4000-8000-000000000002";
const conversation = "30000000-0000-4000-8000-000000000003";
const otherConversation = "40000000-0000-4000-8000-000000000004";
const requestId = "50000000-0000-4000-8000-000000000005";

describe("튜터 복구 migration의 실제 PostgreSQL 계약", () => {
  let db: PGlite;
  let migratedLegacy: unknown[];

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(`
      create schema auth;
      create role authenticated;
      create table auth.users (id uuid primary key);
      insert into auth.users values ('${owner}'), ('${otherOwner}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
    `);
    // 0001의 대화·메시지 DDL을 그대로 사용하고 pgvector가 필요한 앞부분만 제외한다.
    const conversationStart = initialSchema.indexOf("create table if not exists conversations (");
    expect(conversationStart).toBeGreaterThan(-1);
    await db.exec(initialSchema.slice(conversationStart));
    await db.exec(`
      insert into public.conversations (id, user_id) values
        ('${conversation}', '${owner}'), ('${otherConversation}', '${otherOwner}');
      insert into public.messages (conversation_id, role, content)
        values ('${conversation}', 'assistant', '마이그레이션 이전 답변');
    `);
    await db.exec(migration);
    await db.exec(migration);
    migratedLegacy = (await db.query("select retrieval_degraded, client_request_id from public.messages")).rows;

    const conversationPolicy = rlsSchema.match(/create policy "own conversations"[\s\S]*?;/)?.[0];
    const messagePolicy = rlsSchema.match(/create policy "own messages"[\s\S]*?;/)?.[0];
    expect(conversationPolicy).toBeTruthy();
    expect(messagePolicy).toBeTruthy();
    await db.exec(`
      alter table public.conversations enable row level security;
      alter table public.messages enable row level security;
      ${conversationPolicy}
      ${messagePolicy}
      grant usage on schema public, auth to authenticated;
      grant select, insert, update on public.conversations, public.messages to authenticated;
      grant usage, select on all sequences in schema public to authenticated;
    `);
  });

  beforeEach(async () => {
    await db.exec("reset role; truncate public.messages restart identity;");
  });

  afterAll(async () => { await db?.close(); });

  it("재적용해도 과거 답변은 false/null로 남고 새 답변은 기본 false로 저장된다", async () => {
    expect(migratedLegacy).toEqual([{ retrieval_degraded: false, client_request_id: null }]);
    const result = await db.query(`
      insert into public.messages (conversation_id, role, content)
        values ($1, 'assistant', '정상 답변')
        returning retrieval_degraded, client_request_id
    `, [conversation]);
    expect(result.rows).toEqual([{ retrieval_degraded: false, client_request_id: null }]);
    await expect(db.query(`
      insert into public.messages (conversation_id, role, content, retrieval_degraded)
        values ($1, 'assistant', '잘못된 상태', null)
    `, [conversation])).rejects.toMatchObject({ code: "23502" });
  });

  it("검색 장애 여부는 별도 재조회에서도 유지된다", async () => {
    const inserted = await db.query<{ id: number }>(`
      insert into public.messages (conversation_id, role, content, retrieval_degraded)
        values ($1, 'assistant', '제한된 근거의 답변', true) returning id
    `, [conversation]);
    const reloaded = await db.query(`
      select role, content, retrieval_degraded from public.messages where id = $1
    `, [inserted.rows[0].id]);
    expect(reloaded.rows).toEqual([{ role: "assistant", content: "제한된 근거의 답변", retrieval_degraded: true }]);
  });

  it("같은 요청 UUID는 대화가 달라도 중복을 거절하고 null은 여러 개 허용한다", async () => {
    await db.query(`
      insert into public.messages (conversation_id, role, content, client_request_id)
        values ($1, 'user', '원래 질문', $2)
    `, [conversation, requestId]);
    await expect(db.query(`
      insert into public.messages (conversation_id, role, content, client_request_id)
        values ($1, 'user', '다른 대화 재시도', $2)
    `, [otherConversation, requestId])).rejects.toMatchObject({ code: "23505", constraint: "messages_client_request_id_idx" });
    await db.query(`
      insert into public.messages (conversation_id, role, content)
        values ($1, 'assistant', '답변 1'), ($1, 'assistant', '답변 2'), ($1, 'user', '과거 질문')
    `, [conversation]);
    const counted = await db.query<{ count: number }>("select count(*)::int as count from public.messages where client_request_id is null");
    expect(counted.rows).toEqual([{ count: 3 }]);
  });

  it("assistant가 사용자 요청 UUID를 차지하는 INSERT·UPDATE를 거절한다", async () => {
    await expect(db.query(`
      insert into public.messages (conversation_id, role, content, client_request_id)
        values ($1, 'assistant', '위조 답변', $2)
    `, [conversation, requestId])).rejects.toMatchObject({ code: "23514", constraint: "messages_user_request_id" });
    const inserted = await db.query<{ id: number }>(`
      insert into public.messages (conversation_id, role, content, client_request_id)
        values ($1, 'user', '질문', $2) returning id
    `, [conversation, requestId]);
    await expect(db.query("update public.messages set role = 'assistant' where id = $1", [inserted.rows[0].id]))
      .rejects.toMatchObject({ code: "23514", constraint: "messages_user_request_id" });
  });

  it("UUID 조회에 기존 소유자 RLS가 유지되어 타인 질문과 검색 장애 상태를 숨긴다", async () => {
    await db.query(`
      insert into public.messages (conversation_id, role, content, client_request_id)
        values ($1, 'user', '타인의 질문', $2);
    `, [otherConversation, requestId]);
    await db.query(`
      insert into public.messages (conversation_id, role, content, retrieval_degraded)
        values ($1, 'assistant', '타인의 답변', true)
    `, [otherConversation]);
    await db.exec(`set role authenticated; set "request.jwt.claim.sub" = '${owner}';`);
    try {
      const hidden = await db.query("select content, retrieval_degraded from public.messages where client_request_id = $1", [requestId]);
      expect(hidden.rows).toEqual([]);
      const hiddenConversation = await db.query("select content, retrieval_degraded from public.messages where conversation_id = $1", [otherConversation]);
      expect(hiddenConversation.rows).toEqual([]);
      await expect(db.query(`
        insert into public.messages (conversation_id, role, content)
          values ($1, 'user', '타인 대화 쓰기')
      `, [otherConversation])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.exec("reset role");
    }
  });
});
