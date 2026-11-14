-- Phase 4: what a repository declares about itself — its manifests, the
-- dependencies they name, the configuration it reads and the entry points it
-- exposes.
--
-- Three tables, all additive and all following the pattern symbols and routes
-- already set: rows hang off an analysis, carry the organization, and are
-- matched to stored files by path in a function that aborts rather than drops.
--
-- Two things are deliberately NOT here:
--
--   * No lockfile and no installed-package data. A dependency row records a
--     declaration in a manifest, never an installation. Nothing in this schema
--     can say a package is installed, resolved or in use.
--
--   * No configuration values. config_references stores variable NAMES and the
--     file and line that name them. There is no column a secret could be
--     written into, so none can leak through this path.

create table public.manifests (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  -- Repository-relative path of the manifest file itself.
  path text not null,
  -- Repository-relative directory it sits in; "." for the repository root.
  dir text not null,
  -- The parser project the manifest belongs to.
  project text not null,
  ecosystem text not null check (ecosystem in (
    'npm', 'pnpm-workspace', 'cargo', 'go', 'python-requirements', 'python-project'
  )),
  -- The package/module name the manifest declares, when it declares one.
  name text,
  -- Workspace globs it declares.
  workspaces jsonb not null default '[]'::jsonb,
  -- Commands it declares, as [{ name, command }].
  scripts jsonb not null default '[]'::jsonb,
  -- What could not be read, by field. A manifest that half-parsed says so
  -- rather than looking like a manifest with nothing in it.
  problems jsonb not null default '[]'::jsonb,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  unique (analysis_id, path)
);

create index manifests_analysis_idx on public.manifests (analysis_id);
create index manifests_analysis_dir_idx on public.manifests (analysis_id, dir);

create table public.dependencies (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  -- The manifest that declares it, by path.
  manifest_path text not null,
  -- Repository-relative directory of that manifest (the package it belongs to).
  dir text not null,
  name text not null,
  -- Version or constraint exactly as declared; null when the manifest names none.
  version text,
  kind text not null check (kind in ('runtime', 'dev', 'optional', 'peer', 'build', 'indirect')),
  -- How many parsed files import this package by bare specifier. Evidence of
  -- reachability from indexed source, never proof of installation, and a zero
  -- never proves the dependency is unused.
  imported_by integer not null default 0,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  -- A dependency belongs to a manifest of the same analysis. Enforced here so
  -- a dependency can never hang off another analysis's manifest.
  foreign key (analysis_id, manifest_path)
    references public.manifests (analysis_id, path) on delete cascade
);

create index dependencies_analysis_idx on public.dependencies (analysis_id);
create index dependencies_analysis_name_idx on public.dependencies (analysis_id, name);
create index dependencies_analysis_manifest_idx on public.dependencies (analysis_id, manifest_path);

create table public.config_references (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  -- Repository-relative file the reference sits in.
  file_path text not null,
  -- The variable or configuration key NAME. Never a value: no column here
  -- holds one.
  variable text not null,
  -- 1-based line in a source file; 0 for an environment template, whose lines
  -- are not indexed.
  line integer not null,
  kind text not null check (kind in (
    'process.env', 'import.meta.env', 'env-bracket', 'env-example', 'config-object'
  )),
  -- Provenance detail: the declaring object for 'config-object', the group for
  -- 'env-example'.
  detail text,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade
);

create index config_references_analysis_idx on public.config_references (analysis_id);
create index config_references_analysis_variable_idx on public.config_references (analysis_id, variable);
create index config_references_analysis_file_idx on public.config_references (analysis_id, file_path);

create table public.entry_points (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  -- Repository-relative path, as declared or as found.
  path text not null,
  -- 'declared' when a manifest names it, 'inferred' when a structural
  -- convention does. The two are never merged.
  kind text not null check (kind in ('declared', 'inferred')),
  -- What named it: "package.json main", "framework route", "index file".
  source text not null,
  -- The manifest that declared it; null for an inferred entry.
  manifest_path text,
  -- Sub-path, bin name or other qualifier the declaration carried.
  detail text,
  -- True when path is a file this analysis actually indexed.
  resolved boolean not null,
  -- Set only when resolved is false: 'not-indexed' (the file exists but is not
  -- code this parser reads) or 'not-found' (nothing is at that path).
  unresolved_reason text check (unresolved_reason in ('not-indexed', 'not-found')),
  -- Files reachable from this entry by re-export edges alone, breadth-first.
  via jsonb not null default '[]'::jsonb,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  -- The reason explains an unresolved entry and nothing else.
  check ((resolved = false) = (unresolved_reason is not null))
);

create index entry_points_analysis_idx on public.entry_points (analysis_id);
create index entry_points_analysis_kind_idx on public.entry_points (analysis_id, kind);
create index entry_points_analysis_path_idx on public.entry_points (analysis_id, path);

-- Row-level security: every table is readable by the organization that owns
-- the analysis and by nobody else, exactly as symbols and routes are. The
-- event trigger from the base schema enabled RLS on creation; these policies
-- say who may read.
create policy "members read their organization's rows" on public.manifests
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));
create policy "members read their organization's rows" on public.dependencies
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));
create policy "members read their organization's rows" on public.config_references
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));
create policy "members read their organization's rows" on public.entry_points
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Writers. Each takes the analysis id and a JSON array, resolves what it can
-- against rows already stored, and aborts the whole call when a row does not
-- match — a mismatch is a bug upstream, never something to drop quietly.

-- Manifests are standalone: they name no file, so nothing to resolve.
create function public.insert_manifests(p_analysis_id uuid, p_manifests jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_manifests);
  inserted integer;
begin
  insert into public.manifests
    (organization_id, analysis_id, path, dir, project, ecosystem, name, workspaces, scripts, problems)
  select a.organization_id, p_analysis_id, m.path, m.dir, m.project, m.ecosystem,
         m.name, coalesce(m.workspaces, '[]'::jsonb), coalesce(m.scripts, '[]'::jsonb),
         coalesce(m.problems, '[]'::jsonb)
  from jsonb_to_recordset(p_manifests)
    as m (path text, dir text, project text, ecosystem text, name text,
          workspaces jsonb, scripts jsonb, problems jsonb)
  join public.analyses a on a.id = p_analysis_id;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_manifests: % of % manifests stored for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Dependencies resolve their manifest by path within the same analysis.
create function public.insert_dependencies(p_analysis_id uuid, p_dependencies jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_dependencies);
  inserted integer;
begin
  insert into public.dependencies
    (organization_id, analysis_id, manifest_path, dir, name, version, kind, imported_by)
  select m.organization_id, p_analysis_id, d.manifest, d.dir, d.name, d.version, d.kind,
         coalesce(d.imported_by, d."importedBy", 0)
  from jsonb_to_recordset(p_dependencies)
    as d (manifest text, dir text, name text, version text, kind text, imported_by integer, "importedBy" integer)
  join public.manifests m on m.analysis_id = p_analysis_id and m.path = d.manifest;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_dependencies: % of % dependencies matched stored manifests for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Configuration references resolve their file by path, except an environment
-- template, which is not an indexed file: its keys are recorded against the
-- template's own path and are not required to match a files row.
create function public.insert_config_references(p_analysis_id uuid, p_references jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_references);
  inserted integer;
begin
  insert into public.config_references
    (organization_id, analysis_id, file_path, variable, line, kind, detail)
  select a.organization_id, p_analysis_id, r.file, r.variable, r.line, r.kind, r.detail
  from jsonb_to_recordset(p_references)
    as r (file text, variable text, line integer, kind text, detail text)
  join public.analyses a on a.id = p_analysis_id
  where r.kind = 'env-example'
     or exists (
       select 1 from public.files f
       where f.analysis_id = p_analysis_id and f.path = r.file and f.skip_reason is null
     );
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_config_references: % of % references matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Entry points keep their declared/inferred distinction and their resolution
-- state exactly as the parser reported them. An unresolved entry is stored,
-- not dropped: it is a declaration that did not land, which is a fact.
create function public.insert_entry_points(p_analysis_id uuid, p_entries jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_entries);
  inserted integer;
begin
  insert into public.entry_points
    (organization_id, analysis_id, path, kind, source, manifest_path, detail, resolved, unresolved_reason, via)
  select a.organization_id, p_analysis_id, e.path, e.kind, e.source, e.manifest, e.detail,
         e.resolved, coalesce(e.unresolved_reason, e."unresolvedReason"), coalesce(e.via, '[]'::jsonb)
  from jsonb_to_recordset(p_entries)
    as e (path text, kind text, source text, manifest text, detail text,
          resolved boolean, unresolved_reason text, "unresolvedReason" text, via jsonb)
  join public.analyses a on a.id = p_analysis_id;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_entry_points: % of % entry points stored for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Only the pipeline's writer calls these.
revoke execute on function public.insert_manifests(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_manifests(uuid, jsonb) to service_role;
revoke execute on function public.insert_dependencies(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_dependencies(uuid, jsonb) to service_role;
revoke execute on function public.insert_config_references(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_config_references(uuid, jsonb) to service_role;
revoke execute on function public.insert_entry_points(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_entry_points(uuid, jsonb) to service_role;
