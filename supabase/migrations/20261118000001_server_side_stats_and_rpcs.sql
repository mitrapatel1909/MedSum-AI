-- MedSumAI migration 001: server-side stats, search logging and newsletter signup.
--
-- Safe to apply BEFORE the new frontend ships: it only adds functions and hardens an
-- unused helper, so the current site keeps working. Migration 002 (lock down the public
-- tables) must be applied AFTER the new frontend is live, because it removes the direct
-- table access the old frontend relies on.
--
-- NOTE: Supabase's security advisor will flag record_search / get_search_count / subscribe
-- as "SECURITY DEFINER functions callable by anon". That is intentional: they are the
-- narrow, validated, rate-limited public API that replaces open table access.

-- 1) Harden the rate-limit helper: pin search_path and stop the public API from calling it.
alter function public.check_and_increment_usage(text, text, integer, integer)
  set search_path = public, pg_temp;

revoke execute on function public.check_and_increment_usage(text, text, integer, integer)
  from public, anon, authenticated;

-- 2) Allow the new action types in the rate-limit table.
alter table public.usage_limits drop constraint if exists usage_limits_action_type_check;
alter table public.usage_limits add constraint usage_limits_action_type_check
  check (action_type = any (array['summarize', 'chat', 'record_search', 'subscribe']));

-- 3) Log a search and bump the counter atomically (replaces browser-side read-then-write).
--    Rate limited to 60 logged searches per hour per IP; over the limit it still returns the
--    current count but writes nothing, so abuse cannot inflate the counter or fill the table.
create or replace function public.record_search(p_topic text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_topic   text := left(btrim(coalesce(p_topic, '')), 200);
  v_hdr     json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      text := coalesce(
                      nullif(v_hdr ->> 'cf-connecting-ip', ''),
                      nullif(btrim(split_part(coalesce(v_hdr ->> 'x-forwarded-for', ''), ',', 1)), ''),
                      'unknown');
  v_allowed boolean;
  v_total   integer;
begin
  if v_topic = '' then
    raise exception 'topic required' using errcode = '22023';
  end if;

  v_allowed := (public.check_and_increment_usage('ip:' || v_ip, 'record_search', 60, 1) ->> 'allowed')::boolean;

  if v_allowed then
    insert into public.searches (topic) values (v_topic);
    update public.search_stats
       set total_searches = coalesce(total_searches, 0) + 1,
           updated_at     = now()
     where id = (select min(id) from public.search_stats)
    returning total_searches into v_total;
  else
    select total_searches into v_total from public.search_stats order by id limit 1;
  end if;

  return coalesce(v_total, 0);
end;
$$;

-- 4) Read-only counter for the homepage.
create or replace function public.get_search_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select total_searches from public.search_stats order by id limit 1), 0);
$$;

-- 5) Newsletter signup: validates the address, rate limits per IP (10/hour), and never reveals
--    whether an address is already subscribed (duplicates are silently ignored).
create or replace function public.subscribe(p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_hdr     json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      text := coalesce(
                      nullif(v_hdr ->> 'cf-connecting-ip', ''),
                      nullif(btrim(split_part(coalesce(v_hdr ->> 'x-forwarded-for', ''), ',', 1)), ''),
                      'unknown');
  v_allowed boolean;
begin
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;

  v_allowed := (public.check_and_increment_usage('ip:' || v_ip, 'subscribe', 10, 1) ->> 'allowed')::boolean;
  if not v_allowed then
    raise exception 'too many requests' using errcode = '54000';
  end if;

  insert into public.subscriptions (email) values (v_email)
  on conflict (email) do nothing;
end;
$$;

-- 6) Grants: only the three public entry points are callable by the browser.
revoke all on function public.record_search(text)   from public;
revoke all on function public.get_search_count()    from public;
revoke all on function public.subscribe(text)       from public;
grant execute on function public.record_search(text)   to anon, authenticated;
grant execute on function public.get_search_count()    to anon, authenticated;
grant execute on function public.subscribe(text)       to anon, authenticated;
