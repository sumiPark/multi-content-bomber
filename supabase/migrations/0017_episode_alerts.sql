-- =====================================================================
-- 0017 — 다음 화 알림 (인스타그램 시리즈)
--
-- 시리즈 다음 화가 인스타에 올라가면, 직전 화에 댓글 단 사람들에게
-- "N화 올라왔어요" 대댓글을 달아준다. 인스타그램 전용, 계정별로 관리.
--
--   series                  시리즈 (계정 1개에 속함)
--   series_episodes         회차 ↔ 인스타 게시물
--   episode_alert_settings  계정별 설정 (켜기, 확인 후/바로 보내기, 답글 문구, 하루 상한)
--   episode_alert_tasks     알림 작업 (새 회차 1개 = 작업 1개)
--   episode_alert_replies   댓글별 결과 (보냄/건너뜀/제외/실패)
--
-- 흐름: 발행 워커가 시리즈 회차 발행에 성공하면 series_episodes 기록 + 작업 생성 →
--   episode-alerts 워크플로(worker/process-alerts.ts)가 직전 화 댓글을 모아 답글 대상을
--   만들고(COLLECTING), 확인 후 보내기면 AWAITING_APPROVAL에서 사람을 기다리고,
--   SENDING에서 속도를 조절하며 대댓글을 등록한다.
--
-- 쓰기는 모두 서버 액션/워커가 service_role로 한다(권한 검증은 앱에서). authenticated는
-- 같은 조직 데이터 SELECT만.
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--   ⚠️ 앱 코드가 이 테이블들을 조회하므로 배포 전에 먼저 적용할 것.
--   types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. series
-- ---------------------------------------------------------------------
create table if not exists public.series (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  -- 계정은 소프트 해제(0016)라 행이 남는다. NO ACTION으로 실수 DELETE에서 이력 보호.
  social_account_id uuid not null references public.social_accounts (id),
  name              text not null check (char_length(btrim(name)) between 1 and 60),
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- 삭제는 소프트 — 보낸 답글 기록이 시리즈를 참조하므로 행은 남긴다.
  deleted_at        timestamptz
);

create unique index if not exists series_name_per_account_unique
  on public.series (social_account_id, name)
  where deleted_at is null;
create index if not exists series_org_idx on public.series (organization_id);

drop trigger if exists trg_series_updated_at on public.series;
create trigger trg_series_updated_at before update on public.series
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2. series_episodes
-- ---------------------------------------------------------------------
create table if not exists public.series_episodes (
  id              uuid primary key default gen_random_uuid(),
  series_id       uuid not null references public.series (id) on delete cascade,
  episode_no      int not null check (episode_no > 0),
  ig_media_id     text not null,
  permalink       text,
  caption         text,
  media_type      text,
  posted_at       timestamptz,
  -- MCB로 올린 회차면 채워진다. 인스타에서 불러온 회차는 NULL.
  content_id      uuid references public.contents (id) on delete set null,
  publish_job_id  uuid references public.publish_jobs (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (series_id, episode_no),
  unique (series_id, ig_media_id)
);

-- ---------------------------------------------------------------------
-- 3. episode_alert_settings — 계정별 설정
--    행이 없으면 앱 기본값(켜짐, 확인 후 보내기, 기본 문구 3개, 하루 200개)을 쓴다.
-- ---------------------------------------------------------------------
create table if not exists public.episode_alert_settings (
  social_account_id uuid primary key references public.social_accounts (id),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  enabled           boolean not null default true,
  mode              text not null default 'APPROVAL' check (mode in ('APPROVAL', 'AUTO')),
  -- 비어 있으면 앱 기본 문구(lib/episode-alerts/templates.ts)를 쓴다.
  templates         text[] not null default '{}',
  daily_limit       int not null default 200 check (daily_limit between 1 and 1000),
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_episode_alert_settings_updated_at on public.episode_alert_settings;
create trigger trg_episode_alert_settings_updated_at before update on public.episode_alert_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. episode_alert_tasks — 새 회차 1개당 작업 1개
--   COLLECTING        직전 화 댓글을 모으는 중 (워커가 집어감)
--   AWAITING_APPROVAL 확인 후 보내기 — 사람이 대상을 보고 보내기를 누를 때까지 대기
--   SENDING           답글 등록 중 (워커가 집어감, 하루 상한에 걸리면 scheduled_for로 미룸)
--   DONE / FAILED / CANCELLED
-- ---------------------------------------------------------------------
create table if not exists public.episode_alert_tasks (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  series_id          uuid not null references public.series (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id),
  source_episode_id  uuid not null references public.series_episodes (id) on delete cascade,
  target_episode_id  uuid not null references public.series_episodes (id) on delete cascade,
  status             text not null default 'COLLECTING'
    check (status in ('COLLECTING', 'AWAITING_APPROVAL', 'SENDING', 'DONE', 'FAILED', 'CANCELLED')),
  -- 작업을 만들 때의 설정 스냅샷. 나중에 설정을 바꿔도 진행 중 작업은 그대로.
  mode               text not null check (mode in ('APPROVAL', 'AUTO')),
  scheduled_for      timestamptz not null default now(),
  -- 워커 선점 표시. claim RPC가 채우고 처리 후 NULL로 푼다. 오래되면 회수.
  locked_at          timestamptz,
  error_count        int not null default 0,
  last_error         text,
  -- NULL이면 발행 워커가 자동으로 만든 작업.
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  unique (target_episode_id)
);

create index if not exists episode_alert_tasks_account_idx
  on public.episode_alert_tasks (social_account_id, created_at desc);
create index if not exists episode_alert_tasks_due_idx
  on public.episode_alert_tasks (scheduled_for)
  where status in ('COLLECTING', 'SENDING');

drop trigger if exists trg_episode_alert_tasks_updated_at on public.episode_alert_tasks;
create trigger trg_episode_alert_tasks_updated_at before update on public.episode_alert_tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. episode_alert_replies — 댓글별 결과
-- ---------------------------------------------------------------------
create table if not exists public.episode_alert_replies (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.episode_alert_tasks (id) on delete cascade,
  ig_comment_id      text not null,
  commenter_ig_id    text,
  commenter_username text,
  comment_text       text,
  commented_at       timestamptz,
  status             text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'SKIPPED', 'EXCLUDED', 'FAILED')),
  skip_reason        text,
  reply_text         text,
  reply_ig_id        text,
  error              text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  unique (task_id, ig_comment_id)
);

create index if not exists episode_alert_replies_task_status_idx
  on public.episode_alert_replies (task_id, status);
create index if not exists episode_alert_replies_sent_idx
  on public.episode_alert_replies (sent_at)
  where status = 'SENT';

-- ---------------------------------------------------------------------
-- 6. publish_jobs.series_id — 업로드 마법사에서 "다음 화로 올리기"를 고른 발행 건.
--    발행 성공 시 워커가 이 시리즈의 다음 회차로 기록한다.
-- ---------------------------------------------------------------------
alter table public.publish_jobs
  add column if not exists series_id uuid references public.series (id);

-- ---------------------------------------------------------------------
-- 7. 작업별 집계 뷰 (security_invoker — 조회자의 RLS가 그대로 적용)
-- ---------------------------------------------------------------------
create or replace view public.episode_alert_task_stats
with (security_invoker = true) as
select
  task_id,
  count(*)::int                                        as total,
  count(*) filter (where status = 'PENDING')::int      as pending,
  count(*) filter (where status = 'SENT')::int         as sent,
  count(*) filter (where status = 'SKIPPED')::int      as skipped,
  count(*) filter (where status = 'EXCLUDED')::int     as excluded,
  count(*) filter (where status = 'FAILED')::int       as failed
from public.episode_alert_replies
group by task_id;

-- ---------------------------------------------------------------------
-- 8. RPC — add_series_episode
--   다음 회차 번호를 원자적으로 매겨 추가한다(시리즈 행 잠금). 같은 게시물이 이미
--   회차로 있으면 그 행을 그대로 돌려준다(발행 워커 재시도에도 중복 회차 없음).
-- ---------------------------------------------------------------------
create or replace function public.add_series_episode(
  p_series_id      uuid,
  p_ig_media_id    text,
  p_permalink      text default null,
  p_caption        text default null,
  p_media_type     text default null,
  p_posted_at      timestamptz default null,
  p_content_id     uuid default null,
  p_publish_job_id uuid default null
)
returns public.series_episodes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  public.series_episodes;
  v_next int;
begin
  perform 1 from public.series
   where id = p_series_id and deleted_at is null
   for update;
  if not found then
    raise exception 'series % not found or deleted', p_series_id;
  end if;

  select * into v_row
    from public.series_episodes
   where series_id = p_series_id and ig_media_id = p_ig_media_id;
  if found then
    return v_row;
  end if;

  select coalesce(max(episode_no), 0) + 1 into v_next
    from public.series_episodes
   where series_id = p_series_id;

  insert into public.series_episodes (
    series_id, episode_no, ig_media_id, permalink, caption, media_type,
    posted_at, content_id, publish_job_id
  ) values (
    p_series_id, v_next, p_ig_media_id, p_permalink, p_caption, p_media_type,
    p_posted_at, p_content_id, p_publish_job_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.add_series_episode(uuid, text, text, text, text, timestamptz, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.add_series_episode(uuid, text, text, text, text, timestamptz, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 9. RPC — claim_episode_alert_tasks
--   워커가 처리할 작업을 FOR UPDATE SKIP LOCKED로 선점한다(locked_at 기록).
--   대상: COLLECTING/SENDING 이고 scheduled_for가 지났고, 잠겨 있지 않거나 잠금이
--   p_stale_minutes보다 오래된 것(워커 크래시 회수).
-- ---------------------------------------------------------------------
create or replace function public.claim_episode_alert_tasks(
  p_limit         int default 20,
  p_stale_minutes int default 60
)
returns setof public.episode_alert_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.episode_alert_tasks t
     set locked_at = now()
   where t.id in (
     select c.id
       from public.episode_alert_tasks c
      where c.status in ('COLLECTING', 'SENDING')
        and c.scheduled_for <= now()
        and (
          c.locked_at is null
          or c.locked_at < now() - make_interval(mins => p_stale_minutes)
        )
      order by c.scheduled_for asc
      limit p_limit
      for update skip locked
   )
  returning t.*;
end;
$$;

revoke execute on function public.claim_episode_alert_tasks(int, int) from public, anon, authenticated;
grant  execute on function public.claim_episode_alert_tasks(int, int) to service_role;

-- ---------------------------------------------------------------------
-- 10. RLS — 같은 조직 SELECT만. 쓰기 정책 없음(service_role 전용).
-- ---------------------------------------------------------------------
alter table public.series                 enable row level security;
alter table public.series_episodes        enable row level security;
alter table public.episode_alert_settings enable row level security;
alter table public.episode_alert_tasks    enable row level security;
alter table public.episode_alert_replies  enable row level security;

drop policy if exists "series_select_org" on public.series;
create policy "series_select_org" on public.series
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists "series_episodes_select_org" on public.series_episodes;
create policy "series_episodes_select_org" on public.series_episodes
  for select to authenticated
  using (
    exists (
      select 1 from public.series s
       where s.id = series_episodes.series_id
         and s.organization_id = public.current_org_id()
    )
  );

drop policy if exists "episode_alert_settings_select_org" on public.episode_alert_settings;
create policy "episode_alert_settings_select_org" on public.episode_alert_settings
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists "episode_alert_tasks_select_org" on public.episode_alert_tasks;
create policy "episode_alert_tasks_select_org" on public.episode_alert_tasks
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists "episode_alert_replies_select_org" on public.episode_alert_replies;
create policy "episode_alert_replies_select_org" on public.episode_alert_replies
  for select to authenticated
  using (
    exists (
      select 1 from public.episode_alert_tasks t
       where t.id = episode_alert_replies.task_id
         and t.organization_id = public.current_org_id()
    )
  );

grant select on public.episode_alert_task_stats to authenticated;
