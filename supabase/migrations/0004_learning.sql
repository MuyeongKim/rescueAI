-- 0004_learning.sql — 교육훈련 플랫폼: 학습 진도 + 퀴즈 이수
-- 과정(course) = 카테고리, 레슨(lesson) = 해당 카테고리의 documents (자료 자동 편성).
-- 0001~0003 적용 후 실행하세요.

-- 레슨(자료) 학습 완료 기록
create table if not exists lesson_progress (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  document_id bigint references documents(id) on delete cascade,
  created_at  timestamptz default now(),
  unique (user_id, document_id)
);
create index if not exists lesson_progress_user_idx on lesson_progress(user_id);
create index if not exists lesson_progress_doc_idx on lesson_progress(document_id);

-- 퀴즈 응시/이수 기록 (questions: [{question, choices[], answerIndex, explanation, source, selected}])
create table if not exists quiz_attempts (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  category   text,
  score      int,
  total      int,
  passed     boolean default false,
  questions  jsonb,
  created_at timestamptz default now()
);
create index if not exists quiz_attempts_user_idx on quiz_attempts(user_id, created_at desc);
create index if not exists quiz_attempts_category_idx on quiz_attempts(category);

-- RLS
alter table lesson_progress enable row level security;
alter table quiz_attempts   enable row level security;

drop policy if exists "own lesson_progress" on lesson_progress;
create policy "own lesson_progress" on lesson_progress for all using (auth.uid() = user_id);

drop policy if exists "own quiz_attempts" on quiz_attempts;
create policy "own quiz_attempts" on quiz_attempts for all using (auth.uid() = user_id);

-- 관리자 통계용 (profiles 하위쿼리는 "own profile select"로 해결되어 재귀하지 않음)
drop policy if exists "admin read lesson_progress" on lesson_progress;
create policy "admin read lesson_progress" on lesson_progress for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
drop policy if exists "admin read quiz_attempts" on quiz_attempts;
create policy "admin read quiz_attempts" on quiz_attempts for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
