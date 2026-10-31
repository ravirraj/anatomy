-- After the RLS test transaction: the database must be as it was. One row,
-- zeros in both columns — see scripts/test-content-rls.ts.
select (select count(*) from public.file_contents where organization_id like 'rls_%') as contents,
       (select count(*) from public.organizations where id like 'rls_%') as test_orgs;
