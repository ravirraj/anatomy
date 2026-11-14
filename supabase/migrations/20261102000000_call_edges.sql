-- Phase 3: allow 'call' as an edge kind for intra-file and cross-file call relationships.
alter table public.edges drop constraint if exists edges_kind_check;
alter table public.edges add constraint edges_kind_check
  check (kind in ('import', 're-export', 'dynamic-import', 'require', 'call'));
