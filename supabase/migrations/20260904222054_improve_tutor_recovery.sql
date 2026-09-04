-- 검색 장애 안내를 재열람에서도 유지하고 같은 질문의 재시도 저장을 식별한다.
alter table public.messages
  add column if not exists retrieval_degraded boolean not null default false,
  add column if not exists client_request_id uuid;

create unique index if not exists messages_client_request_id_idx
  on public.messages (client_request_id)
  where client_request_id is not null;

alter table public.messages drop constraint if exists messages_user_request_id;
alter table public.messages add constraint messages_user_request_id
  check (client_request_id is null or role = 'user');

comment on column public.messages.retrieval_degraded is
  '답변 생성 당시 검색 장애 여부. 과거 미기록 메시지는 false이며 정상 검색을 소급 보증하지 않는다.';
comment on column public.messages.client_request_id is
  '사용자 질문의 재시도 UUID. 소유자 RLS 조회 및 본문 일치 검사와 함께 사용한다.';
