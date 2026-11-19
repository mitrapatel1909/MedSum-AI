-- Index the foreign key and evaluate auth.uid() once per query instead of once per row.
create index if not exists saved_summaries_user_id_idx on public.saved_summaries (user_id);
drop policy if exists "Users can manage their own summaries" on public.saved_summaries;
create policy "Users can manage their own summaries" on public.saved_summaries for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
