-- ==========================================
-- APPLYFLOW AI — keep the server awake
-- ==========================================
-- Vercel shuts the backend down after a few idle minutes; the next request then waits
-- for a "cold start". Every 3 minutes this pings POST /internal/warm (same shared
-- secret as the scheduler), which keeps one server instance warm and makes one tiny
-- database read — so the Supabase free project also counts as active.
-- Cost: ~14,400 tiny requests a month, a few % of Vercel's free allowance; no AI tokens.

select cron.unschedule(jobid) from cron.job where jobname = 'applyflow-keep-warm';

select cron.schedule(
  'applyflow-keep-warm',
  '*/3 * * * *',
  $job$
  select net.http_post(
           url := (select value from public.applyflow_config where key = 'public_url') || '/internal/warm',
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'X-Cron-Secret', (select value from public.applyflow_config where key = 'cron_secret')),
           body := '{}'::jsonb,
           timeout_milliseconds := 20000)
   where exists (select 1 from public.applyflow_config where key = 'cron_secret');
  $job$
);
