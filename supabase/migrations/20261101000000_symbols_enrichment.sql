-- Phase 2: enrich symbols with signature, parameters, return type, documentation,
-- export kind and declaration range. Additive and backward-compatible: every
-- new column is nullable, and insert_symbols accepts them with defaults so
-- older parser payloads (schema < 6) still load.

alter table public.symbols
  add column if not exists end_line integer,
  add column if not exists export_kind text check (export_kind in ('named', 'default', 'none')),
  add column if not exists parameters jsonb,
  add column if not exists return_type text,
  add column if not exists signature text,
  add column if not exists documentation text;

create or replace function public.insert_symbols(p_analysis_id uuid, p_symbols jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expected integer := jsonb_array_length(p_symbols);
  inserted integer;
begin
  insert into public.symbols (
    organization_id, analysis_id, file_id, name, kind, line, end_line,
    exported, export_kind, parameters, return_type, signature, documentation
  )
  select
    f.organization_id,
    p_analysis_id,
    f.id,
    s.name,
    s.kind,
    s.line,
    s.end_line,
    s.exported,
    s.export_kind,
    s.parameters,
    s.return_type,
    s.signature,
    s.documentation
  from jsonb_to_recordset(p_symbols) as s (
    file text,
    name text,
    kind text,
    line integer,
    exported boolean,
    end_line integer,
    export_kind text,
    parameters jsonb,
    return_type text,
    signature text,
    documentation text
  )
  join public.files f on f.analysis_id = p_analysis_id and f.path = s.file and f.skip_reason is null;
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception 'insert_symbols: % of % symbols matched stored files for analysis %', inserted, expected, p_analysis_id;
  end if;
  return inserted;
end;
$$;

revoke execute on function public.insert_symbols(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_symbols(uuid, jsonb) to service_role;
