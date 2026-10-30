-- Source files' bytes, stored once per distinct body. The parser (walk.ts)
-- computes a file's sha256; that hash is the identity of the content here:
-- a file row references its body through files.hash, and rows of this table
-- are never rewritten. Nothing here belongs to an analysis — two analyses of
-- the same unchanged repository share their content — so there is both no
-- analysis_id and no foreign key to files: a content row may briefly outlive
-- the files rows that referenced it (a run deletes those first), and the
-- reverse-lookup index on files below is what garbage collection (a later
-- phase) will read to detect that.

create table public.file_contents (
  organization_id text not null,
  content_hash text not null,
  payload bytea not null,
  -- Bytes as the parser read them, not through any decode. The upper bound
  -- mirrors MAX_FILE_BYTES in lib/parser/walk.ts: storage only ever holds
  -- what the parser parsed, and the parser refuses anything larger.
  size bigint not null check (size >= 0 and size <= 1048576),
  created_at timestamptz not null default now(),
  primary key (organization_id, content_hash),
  constraint file_contents_hash_format_check
    -- sha256 hex lowercase, as walk.ts writes it. Nothing but the real
    -- identity is ever written.
    check (content_hash ~ '^[0-9a-f]{64}$')
);

create index on public.file_contents (organization_id);

-- Garbage collection reads these in reverse: which files still reference a
-- hash? Covered per analysis by the (analysis_id, organization_id) index
-- already; this is the hash lookup it needs.
create index on public.files (organization_id, hash);

-- A re-run replays stored content unchanged: the write path inserts with
-- ON CONFLICT DO NOTHING, so the first write of a body wins and later
-- identical writes are no-ops. Enforced in the schema too — no statement of
-- any kind may rewrite a content row once written. Deletes stay possible:
-- garbage collection (a later phase) is the only thing allowed to remove
-- unreferenced rows, and a removal is not a rewrite.
create or replace function public.preserve_file_contents()
returns trigger
language plpgsql
as $$
begin
  raise exception 'file_contents is immutable: % was not rewritten',
    old.content_hash;
end;
$$;

create trigger file_contents_immutable
  before update on public.file_contents
  for each row execute function public.preserve_file_contents();

-- A member reads their organization's content; only the pipeline's writer
-- (service role, which bypasses row policies) inserts. Same shape as
-- schema.sql applies everywhere else.
revoke all on public.file_contents from anon, authenticated;

grant select on public.file_contents to authenticated;

create policy "members read their organization's rows" on public.file_contents
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Whether a parsed file's body is held: 'absent' begins true of every
-- existing row, so the migration fabricates nothing.
alter table public.files
  add column content_status text
    not null default 'absent'
    check (content_status in ('absent', 'stored'));
