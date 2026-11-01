// Live database checks for remediation phase 1. The suite uses throwaway
// organizations and never prints source bytes, paths containing canaries, or
// database diagnostics from a quarantine rejection.

import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getFileContent } from "../lib/content/read.ts";
import { ContentExcludedError, getContent, putContents, sha256 } from "../lib/content/store.ts";
import { createAdminSupabase } from "../lib/supabase/admin.ts";
import type { Database } from "../lib/supabase/database.types.ts";

const TEST_PREFIX = "content_security_db_test_";
const checks: string[] = [];
const check = (message: string, condition: boolean) => checks.push(`${condition ? "ok   " : "FAIL "} ${message}`);
let stage = "startup";

type Db = ReturnType<typeof createAdminSupabase>;

function localMemberClient(organizationId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
  const jwtSecret = process.env.SUPABASE_TEST_JWT_SECRET;
  if (!url || !anonKey || !jwtSecret) return null;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 300,
    iat: now,
    role: "authenticated",
    sub: `security-test-${organizationId}`,
    o: { id: organizationId },
    org_id: organizationId,
  })}`;
  const signature = createHmac("sha256", jwtSecret).update(unsigned).digest("base64url");
  const token = `${unsigned}.${signature}`;
  return createClient<Database>(url, anonKey, { accessToken: async () => token });
}

async function quarantine(db: Db, organizationId: string, contentHash: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from("content_quarantine").upsert(
    {
      organization_id: organizationId,
      content_hash: contentHash,
      fingerprint: "f".repeat(64),
      hmac_key_version: 1,
      classifier_version: "phase-1-test",
      reason_codes: ["test.canary"],
      first_seen_at: now,
      last_seen_at: now,
    },
    { onConflict: "organization_id,content_hash" },
  );
  if (error) throw new Error(`quarantine write failed (${error.code ?? "unknown-code"})`);
}

async function createAnalysisFile(db: Db, organizationId: string, source: Uint8Array): Promise<string> {
  const projectId = crypto.randomUUID();
  const analysisId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const project = await db.from("projects").insert({
    id: projectId,
    organization_id: organizationId,
    repo_owner: "security-test",
    repo_name: crypto.randomUUID(),
  });
  if (project.error) throw new Error("test project creation failed");
  const analysis = await db.from("analyses").insert({
    id: analysisId,
    organization_id: organizationId,
    project_id: projectId,
    status: "complete",
    commit_sha: "a".repeat(40),
    coverage: {},
    detected_projects: [],
    schema_version: 5,
    stage: "store",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  if (analysis.error) throw new Error("test analysis creation failed");
  const file = await db.from("files").insert({
    id: fileId,
    organization_id: organizationId,
    analysis_id: analysisId,
    path: "security-fixture.ts",
    module: "root",
    hash: sha256(source),
    lines: 1,
    bytes: source.byteLength,
    fan_in: 0,
    fan_out: 0,
    content_status: "absent",
  });
  if (file.error) throw new Error("test file creation failed");
  return fileId;
}

async function main(): Promise<void> {
  stage = "connect";
  const db = createAdminSupabase();
  await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);
  const organizationId = `${TEST_PREFIX}${Date.now()}`;
  const otherOrganizationId = `${organizationId}_other`;
  const organizations = await db.from("organizations").insert([{ id: organizationId }, { id: otherOrganizationId }]);
  if (organizations.error) throw new Error("test organization creation failed");

  const before = Buffer.from("phase-one-store-before-quarantine-canary", "utf8");
  const beforeHash = sha256(before);
  stage = "initial-content-store";
  await putContents(db, organizationId, before);
  stage = "initial-quarantine";
  await quarantine(db, organizationId, beforeHash);
  stage = "initial-quarantine-verification";
  check("quarantine removes content that committed first", (await getContent(db, organizationId, beforeHash)) === null);

  let rejected = false;
  try {
    await putContents(db, organizationId, before);
  } catch (error) {
    rejected = error instanceof ContentExcludedError;
  }
  check("storage is rejected with the typed security result when quarantine committed first", rejected);

  const sameOtherOrg = await putContents(db, otherOrganizationId, before);
  check("quarantine remains organization-scoped", sameOtherOrg.contentHash === beforeHash && (await getContent(db, otherOrganizationId, beforeHash)) !== null);

  stage = "concurrent-store-quarantine";
  let concurrentSafe = true;
  for (let i = 0; i < 12; i++) {
    const bytes = Buffer.from(`phase-one-concurrent-canary-${i}-${crypto.randomUUID()}`, "utf8");
    const hash = sha256(bytes);
    await Promise.allSettled([putContents(db, organizationId, bytes), quarantine(db, organizationId, hash)]);
    const [content, tombstone] = await Promise.all([
      getContent(db, organizationId, hash),
      db.from("content_quarantine").select("content_hash").eq("organization_id", organizationId).eq("content_hash", hash).maybeSingle(),
    ]);
    if (content !== null || tombstone.error || tombstone.data === null) concurrentSafe = false;
  }
  check("concurrent storage and quarantine always converge to tombstone-without-payload", concurrentSafe);

  const backfillBytes = Buffer.from("phase-one-backfill-race-canary", "utf8");
  stage = "backfill-quarantine-race";
  const backfillHash = sha256(backfillBytes);
  const fileId = await createAnalysisFile(db, organizationId, backfillBytes);
  let releaseFetch!: () => void;
  let enteredFetch!: () => void;
  const fetchEntered = new Promise<void>((resolve) => { enteredFetch = resolve; });
  const fetchReleased = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchCount = 0;
  const pendingRead = getFileContent(db, fileId, {
    writer: db,
    cache: null,
    fetchFile: async () => {
      fetchCount++;
      enteredFetch();
      await fetchReleased;
      return backfillBytes;
    },
  });
  await fetchEntered;
  await quarantine(db, organizationId, backfillHash);
  releaseFetch();
  const backfillResult = await pendingRead;
  const { data: guardedFile, error: fileError } = await db.from("files").select("content_status").eq("id", fileId).single();
  check("quarantine winning during GitHub fetch returns no source", backfillResult === null && fetchCount === 1);
  check("the racing backfill retains no payload and finishes excluded", !fileError && guardedFile.content_status === "excluded" && (await getContent(db, organizationId, backfillHash)) === null);

  const excludedReadFetches: string[] = [];
  const excludedRead = await getFileContent(db, fileId, {
    writer: db,
    cache: null,
    fetchFile: async () => {
      excludedReadFetches.push("called");
      return backfillBytes;
    },
  });
  check("an excluded row never triggers a later GitHub backfill", excludedRead === null && excludedReadFetches.length === 0);

  const legacyBytes = Buffer.from("phase-one-legacy-no-backfill", "utf8");
  const legacyFileId = await createAnalysisFile(db, organizationId, legacyBytes);
  const legacyStatus = await db.from("files").update({ content_status: "legacy_unclassified" }).eq("id", legacyFileId);
  if (legacyStatus.error) throw new Error("legacy test file update failed");
  const legacyFetches: string[] = [];
  const legacyRead = await getFileContent(db, legacyFileId, {
    writer: db,
    cache: null,
    fetchFile: async () => {
      legacyFetches.push("called");
      return legacyBytes;
    },
  });
  check("a legacy-unclassified row never triggers GitHub backfill", legacyRead === null && legacyFetches.length === 0);

  const approved = Buffer.from("phase-one-approved-integrity", "utf8");
  stage = "approved-integrity";
  const approvedRef = await putContents(db, organizationId, approved);
  const approvedBack = await getContent(db, organizationId, approvedRef.contentHash);
  check("approved content keeps exact SHA-256 and byte integrity", approvedRef.contentHash === sha256(approved) && approvedBack !== null && Buffer.from(approvedBack).equals(approved));

  stage = "member-rls";
  const approvedFileId = await createAnalysisFile(db, organizationId, approved);
  const approvedStatus = await db.from("files").update({ content_status: "stored" }).eq("id", approvedFileId);
  if (approvedStatus.error) throw new Error("approved test file finalization failed");
  const member = localMemberClient(organizationId);
  const foreignMember = localMemberClient(otherOrganizationId);
  if (member && foreignMember) {
    const [ownRows, foreignRows, quarantineRows] = await Promise.all([
      member.from("file_contents").select("content_hash"),
      foreignMember.from("file_contents").select("content_hash"),
      member.from("content_quarantine").select("content_hash"),
    ]);
    check("a member reads only explicitly stored content in their organization", ownRows.error === null && ownRows.data.some((row) => row.content_hash === approvedRef.contentHash));
    check("a foreign organization cannot read the approved payload", foreignRows.error === null && foreignRows.data.every((row) => row.content_hash !== approvedRef.contentHash));
    check("quarantine metadata is not exposed through the member Data API", quarantineRows.error !== null && quarantineRows.data === null);
  }
}

main()
  .catch((error: unknown) => {
    const safeKind = error instanceof ContentExcludedError
      ? error.name
      : error instanceof Error && error.message.startsWith("quarantine write failed (")
        ? error.message
        : "unexpected error";
    checks.push(`FAIL  suite failed safely at ${stage} (${safeKind})`);
  })
  .finally(async () => {
    try {
      const db = createAdminSupabase();
      await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);
    } catch {
      checks.push("FAIL  test cleanup failed");
    }
    console.log("");
    for (const line of checks) console.log(line);
    const failed = checks.filter((line) => line.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery security-state database check passed." : `\n${failed} security-state database check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
