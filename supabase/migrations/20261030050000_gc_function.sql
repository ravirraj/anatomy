-- Safe garbage collection function for orphaned file contents.
-- Deletes unreferenced file_contents rows older than the grace period,
-- scoped by organization (or all if null), in bounded batches.
-- Rechecks references in the same delete statement with FOR UPDATE SKIP LOCKED
-- to guarantee race safety and concurrency resilience.

create function public.delete_orphaned_file_contents(
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
      and not exists (
        select 1
        from public.files f
        where f.organization_id = fc.organization_id
          and f.hash = fc.content_hash
      )
    order by fc.created_at asc
    limit p_batch_size
    for update skip locked
  ),
  deleted as (
    delete from public.file_contents fc
    using candidates c
    where fc.organization_id = c.organization_id
      and fc.content_hash = c.content_hash
      -- Re-verify references immediately before deletion inside the lock
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

create index if not exists file_contents_created_at_idx on public.file_contents (created_at);

revoke execute on function public.delete_orphaned_file_contents(text, interval, integer) from public, anon, authenticated;
grant execute on function public.delete_orphaned_file_contents(text, interval, integer) to service_role;
