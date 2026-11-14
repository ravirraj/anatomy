-- Bounded retention for the answer cache.
--
-- `ai_cache` previously grew without bound: rows rendered unreachable by a
-- prompt-version bump, a model repin, or a source re-analysis were never
-- matched again but never removed. This migration adds
--
--   1. `expires_at` - a cleanup-eligibility timestamp. It controls pruning
--      ONLY. It is never evidence validity: serving keeps verifying every
--      cache hit against the current evidence before answering, exactly as
--      before, and an entry inside its TTL is still refused the moment it
--      fails verification.
--   2. Batched, expired-first pruning with a per-organization row cap,
--      implemented as a service-role-only function guarded by a
--      transaction-scoped advisory lock (see below).
--
-- The existing RLS setup (auto-enabled by the rls_auto_enable event trigger,
-- the members-read-own-org policy, and the select-only grant to
-- authenticated) is left untouched. Writes and deletes still happen only
-- through the service role.

-- Default: 90 days of retention for every row inserted from now on.
alter table public.ai_cache
  add column expires_at timestamptz not null default now() + interval '90 days';

-- Existing rows get a deterministic timestamp too: 90 days after their own
-- creation, instead of a floating "90 days from whenever the column was
-- added". Rows written by retired prompt versions or pinned models age out
-- honestly. The rewrite is a one-time cost and expires_at is the only new
-- column, so the rewrite is small.
update public.ai_cache
set expires_at = created_at + interval '90 days';

-- Pruning scans: expiry oldest-first within an organization, and cap eviction
-- oldest-creation-first within an organization. Both orders need their own
-- composite index; each also serves any organization-scoped count.
create index on public.ai_cache (organization_id, expires_at);
create index on public.ai_cache (organization_id, created_at);

-- Safe, bounded pruning for ai_cache.
--
-- Deletes expired rows first (they are pure dead weight), then, only if the
-- organization still exceeds its row cap, evicts the oldest rows by
-- created_at. Every phase deletes in bounded batches, and a single
-- invocation deletes at most p_max_deletions rows in total.
--
-- Concurrency:
-- - The whole invocation runs inside the caller's transaction, and each
--   organization is processed under a transaction-scoped advisory lock
--   (`pg_advisory_xact_lock`). Two prune calls touching the same
--   organization therefore serialize: the second one re-reads the row count
--   after the first finished, so the cap is never evaluated twice against
--   the same over-cap state and rows are never evicted beyond the cap.
--   Different organizations prune in parallel without blocking each other.
-- - `FOR UPDATE SKIP LOCKED` is layered on top as a belt-and-braces: pruners
--   are already serialized per organization, so it only guards against rows
--   locked by some other future writer and never affects the cap outcome.
-- - Cache writers never take the prune lock and never evaluate the cap.
--   Concurrent inserts keep the documented insert semantics:
--   unique (organization_id, key) with duplicate inserts ignored, i.e. the
--   first writer wins. The 25,000-row cap is therefore a PRUNING TARGET,
--   not an instantaneous bound: a burst of ordinary inserts can push an
--   organization past the cap (and is never blocked or rejected for doing
--   so); the next invocation of this function converges the organization
--   back to the cap. No lock is added to the write path.
-- - A prune may delete a row a concurrent writer just added; that answer
--   simply misses on the next ask and regenerates through the normal
--   pipeline. Eviction can cost one regeneration, never correctness -
--   every read is still verified before serving.
--
-- Byte statistics: sum of postgres `octet_length(body)` over deleted rows -
-- the exact size of the deleted answer bodies, no estimates.
--
-- Scope: p_organization_id reaches exactly one organization; null means all
-- organizations (the per-org cap and lock are still applied per
-- organization during a global run).
--
-- Only callable by the service role.
create or replace function public.prune_ai_cache(
  p_organization_id text default null,
  p_batch_size integer default 500,
  p_max_deletions integer default 5000,
  p_cap_rows integer default 25000
)
returns table (
  organization_id text,
  expired_rows_deleted integer,
  cap_evicted_rows_deleted integer,
  body_bytes_deleted bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch integer;
  v_budget integer;
  v_cap_rows integer;
  v_org text;
  v_count integer;
  v_deleted integer;
  v_bytes bigint;
  v_org_expired integer;
  v_org_cap integer;
  v_org_bytes bigint;
begin
  v_batch := greatest(1, coalesce(p_batch_size, 500));
  v_budget := greatest(1, coalesce(p_max_deletions, 5000));
  v_cap_rows := greatest(0, coalesce(p_cap_rows, 25000));

  for v_org in
    select a.organization_id
    from public.ai_cache a
    where p_organization_id is null or a.organization_id = p_organization_id
    group by a.organization_id
  loop
    -- The deletion budget is shared across every phase and every
    -- organization: one invocation can never exceed it in total.
    exit when v_budget <= 0;

    v_org_expired := 0;
    v_org_cap := 0;
    v_org_bytes := 0;

    -- Serialize prune invocations that touch this organization. Held until
    -- the caller's transaction ends (released on commit or rollback, so it
    -- cannot leak).
    perform pg_advisory_xact_lock(
      hashtextextended('prune_ai_cache:' || v_org, 0)
    );

    -- Phase 1: expired rows first, oldest expiration first. Runs to
    -- completion (budget permitting) before cap eviction ever looks at
    -- active rows.
    loop
      exit when v_budget <= 0;

      with expired as (
        select c.id
        from public.ai_cache c
        where c.organization_id = v_org
          and c.expires_at <= clock_timestamp()
        order by c.expires_at asc, c.id asc
        limit least(v_batch, v_budget)
        for update skip locked
      ),
      deleted as (
        delete from public.ai_cache d
        using expired e
        where d.id = e.id
        returning d.body
      )
      select count(*)::integer,
             coalesce(sum(octet_length(body)), 0)::bigint
      into v_deleted, v_bytes
      from deleted;

      exit when v_deleted = 0;

      v_budget := v_budget - v_deleted;
      v_org_expired := v_org_expired + v_deleted;
      v_org_bytes := v_org_bytes + v_bytes;
    end loop;

    -- Phase 2: per-organization cap, oldest rows first. Only reached once
    -- expiry work for this organization is done. Re-reads the live row
    -- count every pass; nothing is deleted while the organization is at or
    -- under its cap.
    loop
      exit when v_budget <= 0;

      select count(*)::integer into v_count
      from public.ai_cache a
      where a.organization_id = v_org;

      exit when v_count <= v_cap_rows;

      with oldest as (
        select c.id
        from public.ai_cache c
        where c.organization_id = v_org
        order by c.created_at asc, c.id asc
        limit least(v_batch, v_budget, v_count - v_cap_rows)
        for update skip locked
      ),
      deleted as (
        delete from public.ai_cache d
        using oldest o
        where d.id = o.id
        returning d.body
      )
      select count(*)::integer,
             coalesce(sum(octet_length(body)), 0)::bigint
      into v_deleted, v_bytes
      from deleted;

      exit when v_deleted = 0;

      v_budget := v_budget - v_deleted;
      v_org_cap := v_org_cap + v_deleted;
      v_org_bytes := v_org_bytes + v_bytes;
    end loop;

    organization_id := v_org;
    expired_rows_deleted := v_org_expired;
    cap_evicted_rows_deleted := v_org_cap;
    body_bytes_deleted := v_org_bytes;
    return next;
  end loop;

  return;
end;
$$;

revoke execute on function public.prune_ai_cache(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.prune_ai_cache(text, integer, integer, integer)
  to service_role;
