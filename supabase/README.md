# Supabase migrations

Apply in filename order (Supabase SQL editor, or `supabase db push`).

| File | What it does | When |
|---|---|---|
| `20261118000001_server_side_stats_and_rpcs.sql` | Adds `record_search`, `get_search_count`, `subscribe`; hardens the rate-limit helper | Any time. Does not affect the old frontend |
| `20261118000002_lock_down_public_tables.sql` | Closes direct browser access to `searches`, `search_stats`, `subscriptions`, `usage_limits` | **Only after** the frontend that uses the functions is live. The old frontend breaks without direct access |
| `20261118000003_rate_limit_privacy.sql` | Rate limiter stores a salted hash instead of the raw IP | Any time after 001 |
| `20261118000004_rate_limit_auto_purge.sql` | Deletes expired rate-limit rows automatically | Any time after 001 |

The advisor will report `record_search`, `get_search_count` and `subscribe` as "SECURITY DEFINER functions callable by anon". That is intentional: they are the narrow public API that replaces open table access.
