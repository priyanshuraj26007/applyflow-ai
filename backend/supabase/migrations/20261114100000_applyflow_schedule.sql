-- ==========================================
-- APPLYFLOW AI — scheduled emails
-- ==========================================
-- How it works:
--  1. A tester picks "Send later". The backend writes one row here (who, which
--     application, when) and marks the application "Scheduled".
--  2. Every minute, pg_cron (inside this database) checks for due rows. Only when
--     something is due does it call the backend (pg_net HTTP POST to
--     <PUBLIC_URL>/internal/send-due with a shared secret). Quiet minutes cost a
--     ~1 ms query and never wake the Vercel server.
--  3. The backend claims due rows atomically (applyflow_claim_due), sends each one
--     through that tester's Gmail, and records "sent" or "failed".
-- Everything is private: RLS on, no policies, only the backend's secret key can use it.

create table if not exists public.applyflow_schedule (
  id               uuid        primary key default gen_random_uuid(),
  user_id          text        not null,
  application_id   text        not null,
  send_at          timestamptz not null,
  status           text        not null default 'scheduled'
                   check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  allow_duplicate  boolean     not null default false,
  attempts         integer     not null default 0,
  claimed_at       timestamptz,
  last_error       text,
  app_synced       boolean     not null default false,  -- result copied onto the application?
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- At most one active schedule per application.
create unique index if not exists applyflow_schedule_one_active
  on public.applyflow_schedule (user_id, application_id)
  where status in ('scheduled', 'sending');
create index if not exists applyflow_schedule_due
  on public.applyflow_schedule (send_at) where status = 'scheduled';

alter table public.applyflow_schedule enable row level security;
revoke all on public.applyflow_schedule from anon, authenticated;

-- Small private key/value table for server settings the database itself needs
-- (the backend URL + the shared cron secret). Filled by the backend, never in git.
create table if not exists public.applyflow_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.applyflow_config enable row level security;
revoke all on public.applyflow_config from anon, authenticated;

-- Claim due jobs so two overlapping runs can never send the same email twice.
create or replace function public.applyflow_claim_due(max_jobs integer default 10)
returns setof public.applyflow_schedule
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A job stuck in "sending" for 5+ minutes means the server stopped mid-send.
  -- Never resend it automatically (the email may already have gone out).
  update applyflow_schedule
     set status = 'failed',
         last_error = 'The send was interrupted. Check your Gmail Sent folder, then retry if it is not there.',
         updated_at = now()
   where status = 'sending' and claimed_at < now() - interval '5 minutes';

  return query
  update applyflow_schedule s
     set status = 'sending', claimed_at = now(), attempts = s.attempts + 1, updated_at = now()
   where s.id in (
     select id from applyflow_schedule
      where status = 'scheduled' and send_at <= now()
      order by send_at
      limit max_jobs
      for update skip locked)
  returning s.*;
end;
$$;
revoke all on function public.applyflow_claim_due(integer) from public, anon, authenticated;
grant execute on function public.applyflow_claim_due(integer) to service_role;

-- ---------- The once-a-minute check ----------
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Re-create the job (safe to run again).
select cron.unschedule(jobid) from cron.job where jobname = 'applyflow-send-due';

select cron.schedule(
  'applyflow-send-due',
  '* * * * *',
  $job$
  select net.http_post(
           url := (select value from public.applyflow_config where key = 'public_url') || '/internal/send-due',
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'X-Cron-Secret', (select value from public.applyflow_config where key = 'cron_secret')),
           body := '{}'::jsonb,
           timeout_milliseconds := 60000)
   where exists (select 1 from public.applyflow_config where key = 'cron_secret')
     and (exists (select 1 from public.applyflow_schedule where status = 'scheduled' and send_at <= now())
       or exists (select 1 from public.applyflow_schedule where status = 'sending' and claimed_at < now() - interval '5 minutes')
       or exists (select 1 from public.applyflow_schedule where status = 'failed' and not app_synced));
  $job$
);
