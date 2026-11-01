-- Security-remediation phase 1: explicit content states and an atomic,
-- organization-scoped quarantine gate. This migration deliberately does not
-- classify or delete historical payloads. It makes every existing file
-- legacy-unclassified so historical bytes cannot become backfill evidence by
-- default, and it installs the database invariant later classifier phases use.

-- Existing rows predate the security boundary and are not presumed safe.
alter table public.files
  alter column content_status set default 'legacy_unclassified';

alter table public.files
  drop constraint if exists files_content_status_check;

update public.files
set content_status = 'legacy_unclassified';

alter table public.files
  add constraint files_content_status_check
  check (content_status in ('stored', 'absent', 'excluded', 'legacy_unclassified'));

-- A quarantine row is a payload-free security tombstone. The raw SHA-256 is
-- retained only in this service-only table so the database can enforce the
-- exclusion against the existing content-addressed store. `fingerprint` is an
-- organization-bound HMAC of that hash; its dedicated key and rotation are
-- implemented by the next remediation phase.
create table public.content_quarantine (
  organization_id text not null
    references public.organizations (id) on delete cascade,
  content_hash text not null,
  fingerprint text not null,
  hmac_key_version integer not null check (hmac_key_version > 0),
  classifier_version text not null check (classifier_version <> ''),
  reason_codes text[] not null check (cardinality(reason_codes) > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (organization_id, content_hash),
  constraint content_quarantine_hash_format_check
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint content_quarantine_fingerprint_format_check
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint content_quarantine_seen_order_check
    check (last_seen_at >= first_seen_at)
);

alter table public.content_quarantine enable row level security;

-- No raw hashes, fingerprints, or reason metadata are exposed through the
-- member-facing Data API. The service role is the only application role that
-- may maintain quarantine rows; RLS remains enabled by the repository-wide
-- event trigger as defense in depth.
revoke all on public.content_quarantine from public, anon, authenticated;
grant select, insert, update on public.content_quarantine to service_role;

-- All three writers of security-relevant state use the same transaction
-- advisory lock derived from (organization, SHA-256):
--   1. file_contents insertion/update,
--   2. files insertion/update, including GitHub backfill finalization,
--   3. quarantine insertion/update.
-- A hash collision in hashtextextended can only serialize unrelated work; it
-- cannot weaken the exclusion invariant.
create or replace function public.content_security_lock(
  p_organization_id text,
  p_content_hash text
)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id || pg_catalog.chr(31) || p_content_hash, 0)
  );
$$;

revoke execute on function public.content_security_lock(text, text)
  from public, anon, authenticated;
grant execute on function public.content_security_lock(text, text)
  to service_role;

-- No insert or last-reference refresh can cross an existing quarantine row.
-- The custom SQLSTATE is stable application control flow and the message is
-- intentionally generic: neither source bytes, paths, nor values appear in it.
create or replace function public.guard_file_content_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.content_security_lock(new.organization_id, new.content_hash);
  if exists (
    select 1
    from public.content_quarantine q
    where q.organization_id = new.organization_id
      and q.content_hash = new.content_hash
  ) then
    raise sqlstate 'CG001' using message = 'content excluded by security policy';
  end if;
  return new;
end;
$$;

create trigger file_contents_security_gate
  before insert or update on public.file_contents
  for each row execute function public.guard_file_content_write();

revoke execute on function public.guard_file_content_write()
  from public, anon, authenticated;

-- A file row created after its body was quarantined is forced to `excluded`.
-- A writer may never claim `stored` for quarantined bytes. This closes the
-- interval between content storage and GitHub backfill's metadata update.
create or replace function public.guard_file_content_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.hash is null then
    return new;
  end if;

  perform public.content_security_lock(new.organization_id, new.hash);
  if exists (
    select 1
    from public.content_quarantine q
    where q.organization_id = new.organization_id
      and q.content_hash = new.hash
  ) then
    if new.content_status = 'stored' then
      raise sqlstate 'CG001' using message = 'content excluded by security policy';
    end if;
    new.content_status := 'excluded';
  end if;
  return new;
end;
$$;

create trigger files_content_security_gate
  before insert or update on public.files
  for each row execute function public.guard_file_content_status();

revoke execute on function public.guard_file_content_status()
  from public, anon, authenticated;

-- Quarantine wins atomically in either race order. It first takes the shared
-- lock, then its AFTER trigger removes any earlier payload and marks every
-- same-organization reference excluded in the same transaction. If storage
-- won first, quarantine deletes it. If quarantine won first, the storage gate
-- rejects the later insert.
create or replace function public.lock_content_quarantine()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (old.organization_id is distinct from new.organization_id
          or old.content_hash is distinct from new.content_hash) then
    raise exception 'quarantine identity is immutable';
  end if;
  perform public.content_security_lock(new.organization_id, new.content_hash);
  return new;
end;
$$;

create trigger content_quarantine_lock
  before insert or update on public.content_quarantine
  for each row execute function public.lock_content_quarantine();

create or replace function public.enforce_content_quarantine()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.file_contents fc
  where fc.organization_id = new.organization_id
    and fc.content_hash = new.content_hash;

  update public.files f
  set content_status = 'excluded'
  where f.organization_id = new.organization_id
    and f.hash = new.content_hash
    and f.content_status <> 'excluded';

  return new;
end;
$$;

create trigger content_quarantine_enforcement
  after insert or update on public.content_quarantine
  for each row execute function public.enforce_content_quarantine();

revoke execute on function public.lock_content_quarantine()
  from public, anon, authenticated;
revoke execute on function public.enforce_content_quarantine()
  from public, anon, authenticated;

-- Member reads are limited to content that has an explicitly approved,
-- currently stored file reference. Legacy-unclassified and excluded rows do
-- not expose historical payloads, while exact SHA-256 verification remains
-- unchanged for approved content.
drop policy if exists "members read their organization's rows"
  on public.file_contents;

create policy "members read approved organization content" on public.file_contents
  for select to authenticated
  using (
    organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id'))
    and exists (
      select 1
      from public.files f
      where f.organization_id = file_contents.organization_id
        and f.hash = file_contents.content_hash
        and f.content_status = 'stored'
    )
  );
