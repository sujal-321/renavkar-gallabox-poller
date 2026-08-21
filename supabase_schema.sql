-- Run this once in the Supabase SQL editor.
-- The application also has a chat_history compatibility fallback for projects
-- where the lead_state table has not yet been applied.

-- Conversation history: query support, retention, and server-only access.
create index if not exists chat_history_phone_created_at_idx
  on public.chat_history (phone, created_at desc);

create index if not exists chat_history_created_at_idx
  on public.chat_history (created_at desc);

alter table public.chat_history enable row level security;
revoke all on table public.chat_history from anon, authenticated;

create table if not exists public.lead_state (
  phone text primary key,
  lead_name text,
  requirement text,
  budget text,
  preferred_payment_plan text,
  site_visit_interest text,
  preferred_visit_date text,
  status text not null default 'QUALIFIED',
  cancellation_reason text,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists lead_state_status_idx on public.lead_state (status);
create index if not exists lead_state_updated_at_idx on public.lead_state (updated_at desc);

alter table public.lead_state enable row level security;
revoke all on table public.lead_state from anon, authenticated;

-- Deletes old transcript rows in one controlled operation. Keep the retention
-- window explicit so it can be called by pg_cron or an external scheduler.
create or replace function public.purge_old_chat_history(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_rows integer;
begin
  delete from public.chat_history
  where created_at < now() - make_interval(days => greatest(retention_days, 1));

  get diagnostics deleted_rows = row_count;
  return deleted_rows;
end;
$$;

revoke all on function public.purge_old_chat_history(integer) from public, anon, authenticated;
grant execute on function public.purge_old_chat_history(integer) to service_role;

-- Optional: enable the pg_cron extension, then schedule this once:
-- select cron.schedule(
--   'renavkar-chat-history-retention',
--   '0 3 * * *',
--   $$select public.purge_old_chat_history(90);$$
-- );
