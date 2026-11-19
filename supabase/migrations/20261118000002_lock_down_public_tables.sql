-- MedSumAI migration 002: close direct table access from the public (anon / signed-in) API.
--
-- APPLY ONLY AFTER the new frontend (which uses record_search / get_search_count / subscribe
-- instead of touching these tables directly) is live. The old frontend breaks if this runs first.
--
-- Fixes:
--   * public.subscriptions: anyone could READ every subscriber email.
--   * public.searches:      anyone could read, edit and delete every logged search topic.
--   * public.search_stats:  anyone could set the public counter to any number.
-- RLS stays enabled with no policies, i.e. deny-all for the browser. The service role (used by
-- server-side workflows) bypasses RLS and is unaffected.

drop policy if exists "anon_all_search_stats"  on public.search_stats;
drop policy if exists "auth_all_search_stats"  on public.search_stats;
drop policy if exists "anon_insert_searches"   on public.searches;
drop policy if exists "auth_insert_searches"   on public.searches;
drop policy if exists "insert_subscriptions"   on public.subscriptions;
drop policy if exists "read_subscriptions"     on public.subscriptions;

-- Defense in depth: also remove the table privileges, so a future permissive policy by mistake
-- cannot re-open these tables to the browser.
revoke all on public.search_stats, public.searches, public.subscriptions, public.usage_limits
  from anon, authenticated;
