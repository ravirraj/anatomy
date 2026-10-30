-- The content table's rows are scoped to an organization like everything in
-- public, and follow it out when the organization goes: the constraint should
-- have been on the table in 20261030040722. There are no rows yet, so the
-- foreign key lands on an empty table.
alter table public.file_contents
  add constraint file_contents_organization_id_fkey
  foreign key (organization_id)
  references public.organizations (id)
  on delete cascade;
