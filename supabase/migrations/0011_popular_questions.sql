-- 0011_popular_questions.sql — 챗봇 인기 질문 집계 RPC.
--
-- messages 는 "본인 것만" RLS 라 일반 사용자가 남의 질문을 못 읽는다.
-- 이 함수는 SECURITY DEFINER 로 전체를 집계하되 **질문 문장 + 횟수만** 반환한다
-- (작성자·원본 메시지 미노출). min_count 임계값으로 1회성·개인적 질문은 제외한다.

create or replace function popular_questions(
  days      int default 30,
  min_count int default 2,
  max_rows  int default 8
)
returns table (question text, cnt bigint)
language sql security definer stable
set search_path = public
as $$
  select btrim(content) as question, count(*)::bigint as cnt
  from messages
  where role = 'user'
    and created_at >= now() - make_interval(days => days)
    and char_length(btrim(content)) between 4 and 100
  group by btrim(content)
  having count(*) >= min_count
  order by cnt desc, question
  limit max_rows;
$$;

revoke all on function popular_questions(int, int, int) from public;
grant execute on function popular_questions(int, int, int) to authenticated;
