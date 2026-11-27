-- =====================================================================
-- 0062 — 게시물 댓글 · DM 자동화 (2026-11-27)
--
-- 게시물마다 첫 댓글 · 키워드(또는 모든 댓글) 답글 · DM을 정해 두면, 댓글이 달릴 때 바로 보낸다.
-- 기획: docs/comment-dm-automation.html · 시안: local/design-mockups-v2/9-comment-dm-automation.html
--
--   post_automations          게시물(계정 + 게시물 ID) 하나에 설정 하나. 문구 · 조건은 config(jsonb)
--   post_automation_events    댓글 하나에 기록 하나 — DM · 답글 상태, 실패 이유, 사람 확인
--   post_automation_links     DM 버튼 링크 — MCB 주소(/r/<code>)를 거쳐 클릭 수를 집계
--   post_automation_templates 저장한 템플릿 (설정 창 "무엇을 할까요?" 아래에 나온다)
--   comment_dm_settings       계정별 발송 상한 (시리즈 댓글 답글과 합쳐서 센다)
--   instagram_webhook_inbox   받은 웹훅 원본 (원인 찾기 · 다시 처리용, 14일 보관)
--
-- 흐름: 인스타 웹훅(comments) → /api/webhooks/instagram이 원본을 저장하고 조건을 확인해 기록을 만든 뒤
--   그 자리에서 DM · 답글을 보낸다. 실패 · 상한 초과로 미룬 건은 pg_cron이 1분마다 /api/cron/post-automations를
--   불러 다시 보낸다. 웹훅이 빠졌을 때를 대비해 같은 cron이 5분마다 켜진 게시물의 새 댓글을 직접 확인한다.
--
-- 쓰기는 서버 액션 · API · 워커가 service_role로 한다(권한 확인은 앱). authenticated는 같은 조직 SELECT만.
-- 기록은 지우지 않는다 — 설정은 deleted_at, 계정 해제는 disconnected_at(0016) 소프트 삭제라 기록이 남는다.
--
-- 적용: npx supabase db push --include-all (0063이 먼저 적용돼 있어 --include-all 필요)
--   앱 배포 전에 적용해도 된다 — cron 주소가 배포 전까지 404일 뿐 무해.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. post_automations
-- ---------------------------------------------------------------------
create table if not exists public.post_automations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  -- 계정은 소프트 해제(0016)라 행이 남는다. NO ACTION으로 실수 DELETE에서 기록 보호.
  social_account_id    uuid not null references public.social_accounts (id),
  platform             text not null check (platform in ('INSTAGRAM', 'YOUTUBE')),
  -- 인스타 미디어 ID / 유튜브 영상 ID. 콘텐츠 생성에서 켜면 발행 전이라 NULL → 발행 성공 때 채운다.
  platform_post_id     text,
  post_permalink       text,
  post_caption         text,
  post_posted_at       timestamptz,
  publish_job_id       uuid references public.publish_jobs (id) on delete set null,
  content_id           uuid references public.contents (id) on delete set null,
  product_id           uuid references public.products (id) on delete set null,
  -- 어디서 켰는지 (메뉴 · 콘텐츠 생성 · 직접 촬영 "올렸어요")
  source               text not null default 'MENU' check (source in ('MENU', 'WIZARD', 'SHOOT')),
  -- 문구 · 조건. 형식은 lib/post-automations/config.ts (zod로 검사)
  --   { preset, first:{on,text}, trig:{mode,keywords,match,exclude,emojiOnly},
  --     dm:{on,format,text,btnText,buttons[{label,link,url}],step1,quick,soldout},
  --     reply:{on,when,texts[]}, period:{days,backfill} }
  config               jsonb not null,
  -- WAITING = 발행 기다림(콘텐츠 생성) · ACTIVE = 진행 중 · PAUSED = 멈춤 · ENDED = 기간 끝
  status               text not null default 'ACTIVE'
    check (status in ('WAITING', 'ACTIVE', 'PAUSED', 'ENDED')),
  -- 멈춘 이유: MANUAL(사람이 끔) · SOLDOUT(품절, 안내 문구 없음) · ACCOUNT(연결 끊김) · PUBLISH_FAILED
  paused_reason        text check (paused_reason in ('MANUAL', 'SOLDOUT', 'ACCOUNT', 'PUBLISH_FAILED')),
  starts_at            timestamptz,
  ends_at              timestamptz,
  -- 켤 때 "이미 달린 댓글에도 보내기"를 골랐으면 처음 한 번 7일 안 댓글을 훑는다.
  backfill_done_at     timestamptz,
  -- 첫 댓글 (게시물당 한 번)
  first_comment_status text not null default 'NONE'
    check (first_comment_status in ('NONE', 'PENDING', 'SENT', 'FAILED')),
  first_comment_id     text,
  first_comment_at     timestamptz,
  first_comment_error  text,
  -- 웹훅이 빠졌을 때 직접 확인한 시각 · 그때 댓글 수 (늘었을 때만 목록을 다시 읽는다)
  last_polled_at       timestamptz,
  last_comment_count   int,
  locked_at            timestamptz,
  created_by           uuid references public.profiles (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

-- 같은 게시물에 설정은 하나 (지운 것 제외)
create unique index if not exists post_automations_post_uniq
  on public.post_automations (social_account_id, platform_post_id)
  where deleted_at is null and platform_post_id is not null;
create index if not exists post_automations_org_idx
  on public.post_automations (organization_id, social_account_id, created_at desc);
create index if not exists post_automations_waiting_idx
  on public.post_automations (publish_job_id) where status = 'WAITING';
create index if not exists post_automations_active_idx
  on public.post_automations (last_polled_at) where status = 'ACTIVE' and deleted_at is null;

drop trigger if exists trg_post_automations_updated_at on public.post_automations;
create trigger trg_post_automations_updated_at before update on public.post_automations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2. post_automation_events — 댓글 하나에 한 행
-- ---------------------------------------------------------------------
create table if not exists public.post_automation_events (
  id                 uuid primary key default gen_random_uuid(),
  automation_id      uuid not null references public.post_automations (id),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id),
  comment_id         text not null,
  commenter_id       text,
  commenter_username text,
  comment_text       text,
  commented_at       timestamptz,
  source             text not null check (source in ('WEBHOOK', 'POLL', 'BACKFILL')),
  matched_keyword    text,
  -- 반응하지 않은 이유 (OWN · EXCLUDED · NO_MATCH · EMOJI_ONLY · ALREADY_SENT · EXPIRED · PAUSED · REPLY_OF_REPLY)
  skip_reason        text,

  -- DM: NONE(안 보냄) · PENDING(보낼 차례) · SENDING(보내는 중) · SENT · FAILED · UNKNOWN(결과 모름 → 사람 확인) · SKIPPED
  dm_status          text not null default 'NONE'
    check (dm_status in ('NONE', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED')),
  -- 실제로 보낸 형태 (button이 거절돼 text로 다시 보냈으면 text + dm_fallback)
  dm_format          text check (dm_format in ('button', 'twostep', 'text', 'soldout')),
  dm_fallback        boolean not null default false,
  dm_message_id      text,
  dm_error           text,
  dm_sent_at         timestamptz,
  -- 두 단계: 첫 DM 뒤 빠른 답장을 기다림(WAITING) → 누르면 버튼 메시지(SENT)
  step2_status       text not null default 'NONE'
    check (step2_status in ('NONE', 'WAITING', 'SENT', 'FAILED')),
  step2_sent_at      timestamptz,

  -- 답글
  reply_status       text not null default 'NONE'
    check (reply_status in ('NONE', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
  reply_text         text,
  reply_id           text,
  reply_error        text,
  reply_sent_at      timestamptz,

  -- 재시도 (실패 · 상한 초과로 미룬 건)
  attempts           int not null default 0,
  next_attempt_at    timestamptz,
  locked_at          timestamptz,

  -- 사람 확인 (UNKNOWN 처리)
  resolved_by        uuid references public.profiles (id) on delete set null,
  resolved_at        timestamptz,
  resolution         text check (resolution in ('MARKED_SENT', 'RESENT')),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (automation_id, comment_id)
);

-- 같은 게시물에서 같은 사람에게 DM은 한 번 — 동시에 들어온 웹훅 · 확인이 겹쳐도 DB가 막는다.
create unique index if not exists post_automation_events_one_dm_per_person
  on public.post_automation_events (automation_id, commenter_id)
  where commenter_id is not null and dm_status in ('PENDING', 'SENDING', 'SENT', 'UNKNOWN');
create index if not exists post_automation_events_automation_idx
  on public.post_automation_events (automation_id, created_at desc);
create index if not exists post_automation_events_due_idx
  on public.post_automation_events (next_attempt_at)
  where dm_status = 'PENDING' or reply_status = 'PENDING';
-- 발송 상한 집계 (계정별 최근 1시간 · 24시간)
create index if not exists post_automation_events_dm_sent_idx
  on public.post_automation_events (social_account_id, dm_sent_at) where dm_sent_at is not null;
create index if not exists post_automation_events_reply_sent_idx
  on public.post_automation_events (social_account_id, reply_sent_at) where reply_sent_at is not null;
-- 시리즈 댓글 자동화가 답글 전에 "게시물 자동화가 이미 답했는지" 댓글 ID로 찾는다
create index if not exists post_automation_events_comment_idx
  on public.post_automation_events (comment_id);
-- 두 단계: 빠른 답장이 오면 보낸 사람으로 찾는다
create index if not exists post_automation_events_step2_idx
  on public.post_automation_events (social_account_id, commenter_id) where step2_status = 'WAITING';

drop trigger if exists trg_post_automation_events_updated_at on public.post_automation_events;
create trigger trg_post_automation_events_updated_at before update on public.post_automation_events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. post_automation_links — DM 버튼 링크 (클릭 집계)
--    버튼 링크를 https://mcb.cuma.co.kr/r/<code> 로 보내고, 열리면 clicks를 올린 뒤 target_url로 보낸다.
--    target_url은 문자열 한 칸 — 나중에 모아링크 경유 주소로 바꿔 끼울 수 있다.
-- ---------------------------------------------------------------------
create table if not exists public.post_automation_links (
  code            text primary key check (code ~ '^[A-Za-z0-9]{8,16}$'),
  automation_id   uuid not null references public.post_automations (id),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  button_index    int not null check (button_index between 0 and 2),
  label           text not null,
  target_url      text not null,
  clicks          int not null default 0,
  last_clicked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (automation_id, button_index)
);

drop trigger if exists trg_post_automation_links_updated_at on public.post_automation_links;
create trigger trg_post_automation_links_updated_at before update on public.post_automation_links
  for each row execute function public.set_updated_at();

-- 클릭 한 번 올리고 이동할 주소를 돌려준다 (원자적). /r/<code> 라우트가 service_role로 부른다.
create or replace function public.record_post_automation_link_click(p_code text)
returns text
language sql
security definer
set search_path = public
as $$
  update public.post_automation_links
     set clicks = clicks + 1, last_clicked_at = now()
   where code = p_code
  returning target_url;
$$;
revoke all on function public.record_post_automation_link_click(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. post_automation_templates
-- ---------------------------------------------------------------------
create table if not exists public.post_automation_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 40),
  config          jsonb not null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists post_automation_templates_org_idx
  on public.post_automation_templates (organization_id) where deleted_at is null;

drop trigger if exists trg_post_automation_templates_updated_at on public.post_automation_templates;
create trigger trg_post_automation_templates_updated_at before update on public.post_automation_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. comment_dm_settings — 계정별 발송 상한
--    행이 없으면 앱 기본값(시간당 40 · 하루 200)을 쓴다. 처음엔 낮게 두고 시범 운영 결과로 올린다
--    (사용자 결정, 2026-11-27 — Meta 문서에 DM 속도 상한이 없음). 시리즈 댓글 답글과 합쳐서 센다.
-- ---------------------------------------------------------------------
create table if not exists public.comment_dm_settings (
  social_account_id uuid primary key references public.social_accounts (id),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  hourly_limit      int not null default 40 check (hourly_limit between 1 and 500),
  daily_limit       int not null default 200 check (daily_limit between 1 and 3000),
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_comment_dm_settings_updated_at on public.comment_dm_settings;
create trigger trg_comment_dm_settings_updated_at before update on public.comment_dm_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. instagram_webhook_inbox — 받은 웹훅 원본 (14일 보관)
-- ---------------------------------------------------------------------
create table if not exists public.instagram_webhook_inbox (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),
  object       text,
  ig_account_id text,
  field        text,
  payload      jsonb not null,
  processed_at timestamptz,
  result       text
);
create index if not exists instagram_webhook_inbox_received_idx
  on public.instagram_webhook_inbox (received_at desc);

-- ---------------------------------------------------------------------
-- 7. RLS — 같은 조직 SELECT만 (쓰기는 service_role)
-- ---------------------------------------------------------------------
alter table public.post_automations          enable row level security;
alter table public.post_automation_events    enable row level security;
alter table public.post_automation_links     enable row level security;
alter table public.post_automation_templates enable row level security;
alter table public.comment_dm_settings       enable row level security;
alter table public.instagram_webhook_inbox   enable row level security; -- 정책 없음 = service_role만

drop policy if exists "post_automations_select_org" on public.post_automations;
create policy "post_automations_select_org" on public.post_automations
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "post_automation_events_select_org" on public.post_automation_events;
create policy "post_automation_events_select_org" on public.post_automation_events
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "post_automation_links_select_org" on public.post_automation_links;
create policy "post_automation_links_select_org" on public.post_automation_links
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "post_automation_templates_select_org" on public.post_automation_templates;
create policy "post_automation_templates_select_org" on public.post_automation_templates
  for select to authenticated using (organization_id = public.current_org_id() and deleted_at is null);

drop policy if exists "comment_dm_settings_select_org" on public.comment_dm_settings;
create policy "comment_dm_settings_select_org" on public.comment_dm_settings
  for select to authenticated using (organization_id = public.current_org_id());

-- ---------------------------------------------------------------------
-- 8. RPC — 다시 보낼 기록 선점 (FOR UPDATE SKIP LOCKED, 동시 실행해도 한 번만)
--    PENDING인 DM · 답글 중 next_attempt_at이 지난 것, 그리고 2분 넘게 잡혀 있던 것(멈춘 실행) 회수.
-- ---------------------------------------------------------------------
create or replace function public.claim_post_automation_events(p_limit int default 30)
returns setof public.post_automation_events
language sql
security definer
set search_path = public
as $$
  update public.post_automation_events e
     set locked_at = now()
   where e.id in (
     select id from public.post_automation_events
      where (dm_status = 'PENDING' or reply_status = 'PENDING')
        and (next_attempt_at is null or next_attempt_at <= now())
        and (locked_at is null or locked_at < now() - interval '2 minutes')
      order by next_attempt_at nulls first
      limit p_limit
      for update skip locked
   )
  returning e.*;
$$;
revoke all on function public.claim_post_automation_events(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. pg_cron
--   post-automations-sweep: 1분마다, 할 일이 있을 때만 앱을 부른다
--     (미룬 발송 · 첫 댓글 대기 · 5분 넘게 확인 안 한 켜진 게시물 · 이미 달린 댓글 훑기)
--   post-automations-expire: 1분마다 기간이 끝난 설정을 ENDED로 (앱 호출 없음)
--   instagram-webhook-inbox-prune: 매일 04:10 14일 지난 웹훅 원본 삭제
--   호출 인증은 0020이 Vault에 만든 비밀값을 그대로 쓴다(verify_episode_replies_cron_secret).
-- ---------------------------------------------------------------------
select cron.unschedule(jobname) from cron.job
 where jobname in ('post-automations-sweep', 'post-automations-expire', 'instagram-webhook-inbox-prune');

select cron.schedule(
  'post-automations-sweep',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://mcb.cuma.co.kr/api/cron/post-automations',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'episode_replies_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1 from public.post_automation_events e
     where (e.dm_status = 'PENDING' or e.reply_status = 'PENDING')
       and (e.next_attempt_at is null or e.next_attempt_at <= now())
  )
  or exists (
    select 1 from public.post_automations a
     where a.deleted_at is null
       and a.status = 'ACTIVE'
       and (
         a.first_comment_status = 'PENDING'
         or (a.backfill_done_at is null and (a.config #>> '{period,backfill}') = 'true')
         or a.last_polled_at is null
         or a.last_polled_at < now() - interval '5 minutes'
       )
  );
  $cron$
);

select cron.schedule(
  'post-automations-expire',
  '* * * * *',
  $cron$
  update public.post_automations
     set status = 'ENDED'
   where deleted_at is null
     and status in ('ACTIVE', 'PAUSED')
     and ends_at is not null
     and ends_at <= now();
  $cron$
);

select cron.schedule(
  'instagram-webhook-inbox-prune',
  '10 4 * * *',
  $cron$
  delete from public.instagram_webhook_inbox where received_at < now() - interval '14 days';
  $cron$
);
