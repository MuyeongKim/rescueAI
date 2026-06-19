-- 0008_news.sql — 구조 동향(뉴스) 테이블. 수동 큐레이션(A) + 자동수집(B) 공용.
-- 0001~0007 적용 후 실행. 재실행 안전.

create table if not exists news (
  id           bigserial primary key,
  title        text not null,
  summary      text,
  source       text,                            -- 출처명 (예: 소방청 보도자료, Google News)
  url          text,                            -- 원문 링크
  region       text,                            -- 전국 | 해외
  category     text,                            -- 수난/화재/산악/구급/드론 등
  published_on date,                            -- 기사 날짜
  pinned       boolean not null default false,  -- 상단 고정
  hidden       boolean not null default false,  -- 검수: 숨김(목록에서 제외)
  auto         boolean not null default false,  -- 자동수집 여부(true=B로 수집됨)
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz default now()
);

-- 자동수집 중복 방지: url 이 있는 경우만 유니크(수동 등록은 url 없이도 가능)
create unique index if not exists news_url_uniq on news(url) where url is not null;
-- 피드 정렬 가속(고정 우선, 최신 우선)
create index if not exists news_feed_idx on news(hidden, pinned desc, published_on desc, created_at desc);

alter table news enable row level security;

-- 인증 사용자는 숨김 아닌 항목만 읽기. 작성/수정/삭제·자동수집은 관리자 검증 후 service role(RLS 우회).
drop policy if exists "authenticated read news" on news;
create policy "authenticated read news" on news
  for select to authenticated using (hidden = false);
