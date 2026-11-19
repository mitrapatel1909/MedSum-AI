-- MedSumAI migration 004: automatic cleanup of rate-limit rows.
--
-- Any write to public.usage_limits (i.e. any call that touches the rate limiter) now also deletes
-- rows whose window started more than two days ago, so hashed visitor identifiers do not
-- accumulate. Uses a trigger instead of pg_cron so no extra database extension is required.

create index if not exists usage_limits_window_start_idx on public.usage_limits (window_start);

create or replace function public.purge_old_rate_limits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.usage_limits where window_start < now() - interval '2 days';
  return null;
end;
$$;

revoke all on function public.purge_old_rate_limits() from public, anon, authenticated;

drop trigger if exists usage_limits_purge on public.usage_limits;
create trigger usage_limits_purge
  after insert or update on public.usage_limits
  for each statement execute function public.purge_old_rate_limits();
