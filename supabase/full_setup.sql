-- Row-level security is on by default, not per table. A table that forgot to
-- enable it returns every organization's rows silently; this trigger makes
-- that impossible for anything created in public. It replaces the version the
-- Supabase dashboard installs, which logs and carries on if enabling fails.
-- Here a failure aborts the CREATE TABLE.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
      and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', cmd.object_identity);
  end loop;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      execute function public.rls_auto_enable();
  end if;
end;
$$;

-- Organizations live in Clerk. This row exists so everything else has a real
-- foreign key to cascade from: deleting it deletes the organization's data.
create table public.organizations (
  id text primary key, -- Clerk organization id, as it appears on the token
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  repo_owner text not null,
  repo_name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, repo_owner, repo_name),
  unique (id, organization_id)
);

create type public.analysis_status as enum ('queued', 'parsing', 'complete', 'failed');

-- Children reference their parent by (id, organization_id), so a row can
-- never belong to a different organization than the thing it hangs off.
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  project_id uuid not null,
  status public.analysis_status not null default 'queued',
  commit_sha text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, organization_id),
  foreign key (project_id, organization_id)
    references public.projects (id, organization_id) on delete cascade,
  check ((status = 'failed') = (error is not null)),
  check ((status in ('complete', 'failed')) = (finished_at is not null))
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  path text not null,
  -- Null means parsed. Anything skipped says why, so coverage can count it.
  skip_reason text,
  unique (analysis_id, path),
  unique (id, organization_id),
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade
);

-- Only resolved imports are edges; both ends are real files.
create table public.edges (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  source_file_id uuid not null,
  target_file_id uuid not null,
  kind text not null check (kind in ('import', 're-export', 'dynamic-import', 'require')),
  specifier text not null,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  foreign key (source_file_id, organization_id)
    references public.files (id, organization_id) on delete cascade,
  foreign key (target_file_id, organization_id)
    references public.files (id, organization_id) on delete cascade
);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  file_id uuid not null,
  method text not null,
  path text not null,
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade,
  foreign key (file_id, organization_id)
    references public.files (id, organization_id) on delete cascade
);

create table public.explanations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  file_id uuid not null,
  model text not null,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (file_id, organization_id)
    references public.files (id, organization_id) on delete cascade
);

create table public.file_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  file_id uuid not null unique,
  role text not null,
  -- A role from convention is fact; one from the model is labelled as such.
  source text not null check (source in ('convention', 'model')),
  foreign key (file_id, organization_id)
    references public.files (id, organization_id) on delete cascade
);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (analysis_id, organization_id)
    references public.analyses (id, organization_id) on delete cascade
);

-- Foreign keys aren't indexed automatically; cascades and joins need these.
-- Leading with organization_id also serves the policy predicate.
create index on public.analyses (organization_id, created_at desc);
create index on public.analyses (project_id, organization_id);
create index on public.files (analysis_id, organization_id);
create index on public.files (organization_id);
create index on public.edges (analysis_id, organization_id);
create index on public.edges (source_file_id, organization_id);
create index on public.edges (target_file_id, organization_id);
create index on public.edges (organization_id);
create index on public.routes (analysis_id, organization_id);
create index on public.routes (file_id, organization_id);
create index on public.routes (organization_id);
create index on public.explanations (file_id, organization_id);
create index on public.explanations (organization_id);
create index on public.file_roles (file_id, organization_id);
create index on public.file_roles (organization_id);
create index on public.insights (analysis_id, organization_id);
create index on public.insights (organization_id);
create index on public.projects (organization_id);

-- The whole authorization layer: a row is visible when its organization is
-- the one on the Clerk session token. Clerk's v2 token carries it as o.id,
-- v1 as org_id. Read-only for now; nothing in the app writes yet, so there
-- are no write grants or write policies.
revoke all on
  public.organizations, public.projects, public.analyses, public.files, public.edges,
  public.routes, public.explanations, public.file_roles, public.insights
from anon, authenticated;

grant select on
  public.organizations, public.projects, public.analyses, public.files, public.edges,
  public.routes, public.explanations, public.file_roles, public.insights
to authenticated;

create policy "members read their organization" on public.organizations
  for select to authenticated
  using (id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.projects
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.analyses
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.files
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.edges
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.routes
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.explanations
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.file_roles
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

create policy "members read their organization's rows" on public.insights
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Fail the migration, loudly, if any table in public ended up without RLS.
do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if missing is not null then
    raise exception 'Row-level security is not enabled on: %', missing;
  end if;
end;
$$;
-- The event trigger function is only ever run by Postgres itself. Nobody
-- should be able to reach it through /rest/v1/rpc.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
-- The pipeline: analyses become real runs with named stages, and files and
-- edges carry everything the parser reports about them.

-- The seed rows were stand-ins with no files behind them, and two of their
-- repositories had more than one analysis. Real submissions replace them.
delete from public.organizations
where id in ('org_3JwtW0HcpRZgNX7GbutuxdXoVJS', 'org_3JwxWAXSGXdXZzBg3adiwuaibgC');

-- "parsing" was the name for any unfinished run. Which step it's on is the
-- stage's job now, so the status just says it's running.
alter type public.analysis_status rename value 'parsing' to 'running';

create type public.analysis_stage as enum ('fetch', 'select', 'parse', 'store');

alter table public.analyses
  -- Last stage entered. On a failed run, the stage it failed in.
  add column stage public.analysis_stage,
  add column stage_message text,
  -- Set when a run (or re-run) begins; staleness is measured from here.
  add column started_at timestamptz,
  -- The parser's coverage report, minus the skipped-file list (that's the
  -- files table), and the projects its adapters detected.
  add column coverage jsonb,
  add column projects jsonb,
  add constraint analyses_project_id_key unique (project_id),
  add constraint analyses_stage_check check ((status = 'queued') = (stage is null)),
  add constraint analyses_started_check check ((status = 'queued') = (started_at is null)),
  add constraint analyses_complete_check check (
    (status = 'complete') = (coverage is not null and projects is not null and commit_sha is not null)
  );

-- The unique constraint's index serves lookups by project; this one is redundant.
drop index public.analyses_project_id_organization_id_idx;

-- A parsed file has its measurements; a skipped one has a reason and detail
-- and nothing else, so it can never be mistaken for a file with no imports.
alter table public.files
  add column skip_detail text,
  add column module text,
  add column lines integer,
  add column bytes integer,
  add column hash text,
  add column fan_in integer,
  add column fan_out integer,
  add column reached_by text,
  add constraint files_parsed_or_skipped_check check (
    case when skip_reason is null
      then skip_detail is null and module is not null and lines is not null and bytes is not null
        and hash is not null and fan_in is not null and fan_out is not null
      else skip_detail is not null and module is null and lines is null and bytes is null
        and hash is null and fan_in is null and fan_out is null and reached_by is null
    end
  );

alter table public.edges
  add column type_only boolean not null,
  add column line integer not null,
  add constraint edges_unique_key unique (analysis_id, source_file_id, target_file_id, kind);

-- Edges arrive keyed by path; this resolves both ends against the files
-- already stored for the analysis. An edge whose end isn't a stored file is
-- a bug upstream, so it aborts the call rather than being dropped.
create function public.insert_edges(p_analysis_id uuid, p_edges jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_edges);
  inserted integer;
begin
  insert into public.edges
    (organization_id, analysis_id, source_file_id, target_file_id, kind, specifier, type_only, line)
  select s.organization_id, p_analysis_id, s.id, t.id, e.kind, e.specifier, e.type_only, e.line
  from jsonb_to_recordset(p_edges)
    as e (source text, target text, kind text, specifier text, type_only boolean, line integer)
  join public.files s on s.analysis_id = p_analysis_id and s.path = e.source and s.skip_reason is null
  join public.files t on t.analysis_id = p_analysis_id and t.path = e.target and t.skip_reason is null;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_edges: % of % edges matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Only the pipeline's writer calls this.
revoke execute on function public.insert_edges(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_edges(uuid, jsonb) to service_role;
-- Live progress. Each analysis has a private broadcast channel,
-- "analysis:<id>", and the database publishes to it when a run moves.

-- The channel pattern is declared here, before anything publishes to it: a
-- private channel with no select policy on realtime.messages accepts the
-- broadcast and delivers it to nobody, silently. This is also who may
-- subscribe. The subquery on analyses runs under that table's own policy, so
-- the topic of another organization's analysis matches no row and the join
-- is refused, exactly as its rows aren't selectable. Topics are compared as
-- text so a malformed topic is refused rather than failing a uuid cast.
create policy "members receive their organization's analysis progress" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.analyses a
      where 'analysis:' || a.id::text = (select realtime.topic())
    )
  );

-- No insert policy: browsers listen on these channels and never send. Only
-- the trigger below publishes.

-- The stage and its message, not the row. On failure the message is the
-- reason, so a subscriber shows what arrives without interpreting it.
-- Security definer because it runs inside the pipeline's writes, and
-- publishing is the database's act, not the writer's.
create function public.publish_analysis_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'status', new.status,
      'stage', new.stage,
      'message', case when new.status = 'failed' then new.error else new.stage_message end
    ),
    'progress',
    'analysis:' || new.id::text,
    true
  );
  return null;
end;
$$;

revoke execute on function public.publish_analysis_progress() from public, anon, authenticated;

-- On our own table, never on the realtime machinery.
create trigger publish_progress
  after update of status, stage, stage_message, error on public.analyses
  for each row
  when (
    old.status is distinct from new.status
    or old.stage is distinct from new.stage
    or old.stage_message is distinct from new.stage_message
  )
  execute function public.publish_analysis_progress();
-- "projects" was also the name of the table analyses belong to, so a select
-- of projects(...) and the column read the same. The column is what the
-- parser's adapters detected.
alter table public.analyses rename column projects to detected_projects;
-- Framework adapters: each file's role from convention, and the routes whose
-- method and full pattern the syntax states.

-- Which parser output an analysis was stored from. Rows from an older parser
-- have no roles or routes stored, and must say so rather than show an empty
-- route table and every file unclassified as if that had been checked.
alter table public.analyses add column schema_version integer;
update public.analyses set schema_version = 2 where status = 'complete';
alter table public.analyses
  add constraint analyses_schema_version_check check ((status = 'complete') = (schema_version is not null));

-- Nothing has written a route yet, so the new columns need no backfill.
alter table public.routes
  add column line integer not null,
  add constraint routes_unique_key unique (analysis_id, file_id, method, path);

-- Both arrive keyed by path, like edges, and resolve against the parsed files
-- already stored for the analysis. One that doesn't match aborts the call.
create function public.insert_routes(p_analysis_id uuid, p_routes jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_routes);
  inserted integer;
begin
  insert into public.routes (organization_id, analysis_id, file_id, method, path, line)
  select f.organization_id, p_analysis_id, f.id, r.method, r.pattern, r.line
  from jsonb_to_recordset(p_routes) as r (file text, method text, pattern text, line integer)
  join public.files f on f.analysis_id = p_analysis_id and f.path = r.file and f.skip_reason is null;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_routes: % of % routes matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

create function public.insert_file_roles(p_analysis_id uuid, p_roles jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_roles);
  inserted integer;
begin
  insert into public.file_roles (organization_id, file_id, role, source)
  select f.organization_id, f.id, r.role, 'convention'
  from jsonb_to_recordset(p_roles) as r (path text, role text)
  join public.files f on f.analysis_id = p_analysis_id and f.path = r.path and f.skip_reason is null;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_file_roles: % of % roles matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

-- Only the pipeline's writer calls these.
revoke execute on function public.insert_routes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_routes(uuid, jsonb) to service_role;
revoke execute on function public.insert_file_roles(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_file_roles(uuid, jsonb) to service_role;
-- The names each parsed file exports, ESM and CommonJS alike. A skipped file's
-- syntax is unknown, so it has none, not an empty list. Parsed rows stored by
-- an older parser stay null: their analysis is marked outdated by its schema
-- version and asks to be re-run, and the parser contract refuses a null list
-- on anything newer.
alter table public.files
  add column exports text[],
  add constraint files_skipped_have_no_exports_check check (skip_reason is null or exports is null);
-- Model output, cached by what it was asked rather than which row asked it.

-- Never written to. Keyed by file row, so every re-run would have wiped it
-- along with the files, and a folder has no row to key it by.
drop table public.explanations;

-- The key is a digest of the task, the prompt version, the pinned model and
-- every input the prompt is built from, so an answer is reused exactly when
-- the question is the same. It outlives re-runs: unchanged files and folders
-- are answered again from here. Scoped to the organization like everything
-- else; the pipeline's writer inserts, members only read.
create table public.ai_cache (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  key text not null,
  task text not null check (task in ('explain-file', 'explain-folder', 'classify-file')),
  model text not null,
  body text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

create index on public.ai_cache (organization_id);

revoke all on public.ai_cache from anon, authenticated;
grant select on public.ai_cache to authenticated;

create policy "members read their organization's rows" on public.ai_cache
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Convention owns the structural roles: they decide the route table and which
-- files read as entry points. A role from the model can only ever be one of
-- the layers or plumbing, and the database refuses anything else.
alter table public.file_roles
  add constraint file_roles_model_roles_check check (
    source = 'convention'
    or role in ('service', 'repository', 'model', 'util', 'config', 'component', 'hook')
  );
