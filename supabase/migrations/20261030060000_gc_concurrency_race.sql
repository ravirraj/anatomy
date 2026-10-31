-- Hardens garbage collection and indexing against the concurrency race
-- where an existing orphaned content row (>24h old) is reused by indexing.
--
-- 1. Adds last_referenced_at timestamptz to file_contents, defaulting to now().
-- 2. Updates preserve_file_contents() to allow atomic updates to last_referenced_at
--    while strictly defending content immutability on organization_id, content_hash,
--    payload, size, and created_at.
-- 3. Updates delete_orphaned_file_contents() to evaluate both created_at and
--    last_referenced_at against the grace period, re-checking both inside the
--    row lock immediately before deletion.

alter table public.file_contents
  add column if not exists last_referenced_at timestamptz not null default now();

update public.file_contents
  set last_referenced_at = created_at
  where last_referenced_at is null;

create index if not exists file_contents_last_referenced_at_idx
  on public.file_contents (organization_id, last_referenced_at);

-- Refined immutability trigger:
-- Content identity and payload are strictly immutable: once written, a content row's
-- organization_id, content_hash, payload, size, and created_at can NEVER be modified.
-- Updates to last_referenced_at are permitted to allow indexing to touch/refresh
-- reused content rows atomically and coordinate with garbage collection.
create or replace function public.preserve_file_contents()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id is distinct from new.organization_id
     or old.content_hash is distinct from new.content_hash
     or old.payload is distinct from new.payload
     or old.size is distinct from new.size
     or old.created_at is distinct from new.created_at then
    raise exception 'file_contents is immutable: % was not rewritten',
      old.content_hash;
  end if;
  return new;
end;
$$;

-- Atomic database-side garbage collection function:
-- Deletes unreferenced file_contents rows older than the grace period,
-- scoped by organization (or all if null), in bounded batches.
-- Rechecks references and last_referenced_at inside the same delete statement
-- with FOR UPDATE SKIP LOCKED to guarantee race safety.
create or replace function public.delete_orphaned_file_contents(
  p_organization_id text default null,
  p_grace_period interval default interval '24 hours',
  p_batch_size integer default 500
)
returns table (
  organization_id text,
  content_hash text,
  size bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select fc.organization_id, fc.content_hash, fc.size
    from public.file_contents fc
    where (p_organization_id is null or fc.organization_id = p_organization_id)
      and fc.created_at < (clock_timestamp() - p_grace_period)
      and fc.last_referenced_at < (clock_timestamp() - p_grace_period)
      and not exists (
        select 1
        from public.files f
        where f.organization_id = fc.organization_id
          and f.hash = fc.content_hash
      )
    order by fc.last_referenced_at asc
    limit p_batch_size
    for update skip locked
  ),
  deleted as (
    delete from public.file_contents fc
    using candidates c
    where fc.organization_id = c.organization_id
      and fc.content_hash = c.content_hash
      -- Re-verify references and last_referenced_at inside the row lock immediately before deletion
      and fc.last_referenced_at < (clock_timestamp() - p_grace_period)
      and not exists (
        select 1
        from public.files f
        where f.organization_id = fc.organization_id
          and f.hash = fc.content_hash
      )
    returning fc.organization_id, fc.content_hash, fc.size
  )
  select d.organization_id, d.content_hash, d.size from deleted d;
end;
$$;
