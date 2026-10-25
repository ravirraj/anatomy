-- Symbols: the top-level declarations each parsed file makes, definitions
-- rather than only the exports. A skipped file's syntax is unknown, so it has
-- none. Parsed rows stored by an older parser stay absent, and their analysis
-- is marked outdated by its schema version, like roles and routes before them.

create table public.symbols (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  file_id uuid not null,
  name text not null,
  kind text not null check (kind in ('function', 'class', 'interface', 'type', 'enum', 'namespace', 'const', 'let', 'var')),
  line integer not null,
  exported boolean not null,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  foreign key (file_id, organization_id)
    references public.files (id, organization_id) on delete cascade
);

create index symbols_analysis_idx on public.symbols (analysis_id);

create policy "members read their organization's rows" on public.symbols
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Arrives keyed by path, like routes, and resolves against the parsed files
-- already stored for the analysis. One that doesn't match aborts the call.
create function public.insert_symbols(p_analysis_id uuid, p_symbols jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_symbols);
  inserted integer;
begin
  insert into public.symbols (organization_id, analysis_id, file_id, name, kind, line, exported)
  select f.organization_id, p_analysis_id, f.id, s.name, s.kind, s.line, s.exported
  from jsonb_to_recordset(p_symbols) as s (file text, name text, kind text, line integer, exported boolean)
  join public.files f on f.analysis_id = p_analysis_id and f.path = s.file and f.skip_reason is null;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_symbols: % of % symbols matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Only the pipeline's writer calls these.
revoke execute on function public.insert_symbols(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_symbols(uuid, jsonb) to service_role;
