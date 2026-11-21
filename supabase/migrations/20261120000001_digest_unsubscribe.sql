-- Weekly digest support: a per-subscriber unsubscribe token and two functions that only the
-- Worker (service role) can call. Browsers (anon/authenticated) cannot read emails or tokens.

alter table public.subscriptions
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid(),
  add column if not exists unsubscribed_at timestamptz;

create unique index if not exists subscriptions_unsubscribe_token_key on public.subscriptions (unsubscribe_token);

create or replace function public.digest_recipients()
returns table (email text, unsubscribe_token uuid)
language sql
security definer
set search_path = public, pg_temp
as $$
  select s.email, s.unsubscribe_token from public.subscriptions s where s.active is true;
$$;

create or replace function public.unsubscribe_by_token(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  update public.subscriptions set active = false, unsubscribed_at = now()
  where unsubscribe_token = p_token and active is true;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.digest_recipients() from public, anon, authenticated;
revoke all on function public.unsubscribe_by_token(uuid) from public, anon, authenticated;
grant execute on function public.digest_recipients() to service_role;
grant execute on function public.unsubscribe_by_token(uuid) to service_role;
