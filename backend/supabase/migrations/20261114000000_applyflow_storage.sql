-- ==========================================
-- APPLYFLOW AI — Supabase setup (run once)
-- ==========================================
-- Applied with: npx supabase db push (or paste into Supabase → SQL Editor → Run).
--
-- Every tester's data is a handful of JSON documents (settings, resumes,
-- applications, aboutme, gmail-tokens) keyed by their random tester ID.
-- Resume PDFs go in the private "resumes" storage bucket under <tester ID>/.
--
-- Only the backend can read or write any of it: Row Level Security is ON with
-- no policies, so the public "anon" key gets nothing. The backend uses the
-- secret key (SUPABASE_SECRET_KEY, set in Vercel — never put it in the extension).

create table if not exists public.applyflow_kv (
  user_id    text        not null,
  name       text        not null,
  value      jsonb       not null,
  version    integer     not null default 1,   -- bumped on every write (stops two writes clashing)
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

alter table public.applyflow_kv enable row level security;
revoke all on public.applyflow_kv from anon, authenticated;

-- Private bucket for resume PDFs (4 MB max, PDFs only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 4194304, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 4194304, allowed_mime_types = array['application/pdf'];
