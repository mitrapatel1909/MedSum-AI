-- MedSumAI migration 003: privacy for the rate limiter.
--
-- Migration 001 keyed the rate limiter on the raw client IP. This replaces that with a salted
-- hash (so raw IP addresses are never stored) and opportunistically purges rate-limit rows that
-- are older than two days, so the table cannot grow without bound or keep visitor data around.

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

  -- Housekeeping: roughly 1 call in 50 clears expired rate-limit rows.
  if random() < 0.02 then
    delete from public.usage_limits where window_start < now() - interval '2 days';
  end if;

  v_allowed := (public.check_and_increment_usage('ip:' || md5('msai-rl-v1:' || v_ip), 'record_search', 60, 1) ->> 'allowed')::boolean;

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

  v_allowed := (public.check_and_increment_usage('ip:' || md5('msai-rl-v1:' || v_ip), 'subscribe', 10, 1) ->> 'allowed')::boolean;
  if not v_allowed then
    raise exception 'too many requests' using errcode = '54000';
  end if;

  insert into public.subscriptions (email) values (v_email)
  on conflict (email) do nothing;
end;
$$;
