-- Proves tenant isolation and immutability for public.file_contents against
-- the real database — the thing no fake client can prove.
--
--   supabase db query --linked --file scripts/test-content-rls.sql
--   (or let scripts/test-content-rls.ts run and judge it)
--
-- Everything happens inside ONE transaction whose last statement is ROLLBACK:
-- the database — linked, so it is the project's real one — is left exactly as
-- it was. The only readable output is the final select of rls_check rows, one
-- row per property under test, pass true when the property held.
--
-- A connection's request.jwt.claims is what auth.jwt() reads; set local role
-- authenticated plus a claim of an organization is exactly how PostgREST
-- presents a member of that organization.

begin;

create temp table rls_check (
  id serial primary key,
  name text not null,
  pass boolean not null,
  detail text
);

-- A member's runs of checks below happen as authenticated; the table stays
-- transaction-local, so the grants vanish with it.
grant select, insert on rls_check to authenticated;
grant usage, select on rls_check_id_seq to authenticated;

-- Two organizations that exist for this transaction only. Content rows carry
-- a foreign key to organizations, so the org must be real for a write.
insert into public.organizations (id)
values ('rls_org_a'), ('rls_org_b');

-- Approved content is readable only through a `stored` file reference, so
-- each organization gets the smallest valid project/analysis/file chain.
insert into public.projects (id, organization_id, repo_owner, repo_name)
values ('11111111-1111-4111-8111-111111111111', 'rls_org_a', 'rls', 'a'),
       ('11111111-1111-4111-8111-222222222222', 'rls_org_b', 'rls', 'b');

insert into public.analyses (id, organization_id, project_id)
values ('21111111-1111-4111-8111-111111111111', 'rls_org_a', '11111111-1111-4111-8111-111111111111'),
       ('21111111-1111-4111-8111-222222222222', 'rls_org_b', '11111111-1111-4111-8111-222222222222');

insert into public.files (id, organization_id, analysis_id, path, module, lines, bytes, hash, fan_in, fan_out, content_status)
values ('31111111-1111-4111-8111-111111111111', 'rls_org_a', '21111111-1111-4111-8111-111111111111', 'a.ts', 'root', 1, 1, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', 0, 0, 'stored'),
       ('31111111-1111-4111-8111-222222222222', 'rls_org_b', '21111111-1111-4111-8111-222222222222', 'b.ts', 'root', 1, 1, '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d', 0, 0, 'stored');

-- One byte of content per organization: 'a' and 'b'. The sha256 hex of each
-- byte is the identity it is stored under (computed once, not invented: the
-- store's own test suite pins these same digests).
insert into public.file_contents (organization_id, content_hash, payload, size)
values ('rls_org_a', 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', '\x61', 1),
       ('rls_org_b', '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d', '\x62', 1);

-- 1. The writer's view (the connecting role here, as service_role is for the
--    pipeline): RLS untouched by this role, both rows present.
insert into rls_check (name, pass, detail)
select 'the writer sees both organizations'' rows',
       (select count(*) = 2 from public.file_contents
        where organization_id in ('rls_org_a', 'rls_org_b')),
       null;

-- 2. A member of org a, presented the way PostgREST does.
set local role authenticated;
set local request.jwt.claims = '{"o":{"id":"rls_org_a"}}';

insert into rls_check (name, pass, detail)
select 'a member sees only their own organization''s rows',
       (select count(*) = 1 and bool_and(organization_id = 'rls_org_a')
        from public.file_contents),
       'saw ' || (select count(*) from public.file_contents)::text || ' row(s)';

insert into rls_check (name, pass, detail)
select 'another organization''s hash reads as absent to a foreign member',
       (select not exists (
         select 1 from public.file_contents
         where content_hash = '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d')),
       null;

insert into rls_check (name, pass, detail)
select 'quarantine metadata has no member-facing table privilege',
       not has_table_privilege('authenticated', 'public.content_quarantine', 'select'),
       null;

-- 3. A member cannot write, in any form: only select was granted, and no
--    write policy exists. Every attempted write below must be refused.
do $$
begin
  insert into public.file_contents (organization_id, content_hash, payload, size)
  values ('rls_org_a', '2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6', '\x63', 1);
  insert into rls_check (name, pass, detail)
  values ('a member cannot insert content', false, 'the insert went through');
exception when insufficient_privilege then
  insert into rls_check (name, pass, detail)
  values ('a member cannot insert content', true, null);
end $$;

do $$
begin
  update public.file_contents set size = 2 where organization_id = 'rls_org_a';
  insert into rls_check (name, pass, detail)
  values ('a member cannot update content', false, 'the update went through');
exception when insufficient_privilege then
  insert into rls_check (name, pass, detail)
  values ('a member cannot update content', true, null);
end $$;

do $$
begin
  delete from public.file_contents where organization_id = 'rls_org_a';
  insert into rls_check (name, pass, detail)
  values ('a member cannot delete content', false, 'the delete went through');
exception when insufficient_privilege then
  insert into rls_check (name, pass, detail)
  values ('a member cannot delete content', true, null);
end $$;

-- 4. Back as the writer: the schema itself refuses a rewrite of a content
--    row, whatever the role (the immutable trigger).
set local role postgres;

do $$
begin
  update public.file_contents
  set size = 2
  where organization_id = 'rls_org_a'
    and content_hash = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
  insert into rls_check (name, pass, detail)
  values ('the schema refuses to rewrite stored content', false, 'the update went through');
exception when raise_exception then
  insert into rls_check (name, pass, detail)
  values ('the schema refuses to rewrite stored content', true, null);
end $$;

-- Removal is not a rewrite: garbage collection (a later phase) is the only
-- thing allowed to remove unreferenced content, and it must stay possible.
do $$
begin
  delete from public.file_contents
  where organization_id = 'rls_org_a'
    and content_hash = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
  insert into rls_check (name, pass, detail)
  values ('removal of a content row is not blocked (garbage collection''s job)', true, null);
exception when raise_exception then
  insert into rls_check (name, pass, detail)
  values ('removal of a content row is not blocked (garbage collection''s job)', false, 'the delete was blocked');
end $$;

-- 5. Content cannot exist detached from an organization: the foreign key to
--    organizations refuses a write for an organization that is not there.
do $$
begin
  insert into public.file_contents (organization_id, content_hash, payload, size)
  values ('rls_org_never_existed', 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', '\x61', 1);
  insert into rls_check (name, pass, detail)
  values ('content cannot be written for an organization that does not exist', false, 'the insert went through');
exception when foreign_key_violation then
  insert into rls_check (name, pass, detail)
  values ('content cannot be written for an organization that does not exist', true, null);
end $$;

-- 6. Deleting the organization takes its content with it (on delete cascade).
delete from public.organizations where id = 'rls_org_a';
insert into rls_check (name, pass, detail)
select 'deleting an organization deletes its content',
       (select count(*) = 0 from public.file_contents where organization_id = 'rls_org_a'),
       null;

-- The result: one row per property, pass true when it held. The script never
-- commits — after this select, the connection closes and the seeding
-- (organizations, content rows, and the cascade delete above) all unwinds.
-- scripts/test-content-rls.ts proves the database was left untouched.
select name, pass, detail from rls_check order by id;
