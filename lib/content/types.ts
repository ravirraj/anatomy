// The shape of source-content storage, shared by its callers. The database
// schema it talks to is migration 20261030040722: content addressed by
// (organization, sha256), immutable once written.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types.ts";

export type Db = SupabaseClient<Database>;

/** One body offered for storage. Nothing else about it is trusted. */
export type ContentWrite = { body: Uint8Array };

/**
 * What became of one body offered to the batched write, in the order the
 * writes were given. A whole request's failure marks its writes failed with
 * the database's own reason: requests are not transactions.
 */
export type ContentWriteResult =
  | { stored: true; contentHash: string; size: number }
  | { stored: false; reason: string; reasonCode?: string };

export type ContentStatus = "stored" | "absent" | "excluded" | "legacy_unclassified";

/** Only an explicitly absent file may use the commit-pinned GitHub backfill. */
export function isBackfillEligible(status: string): status is "absent" {
  return status === "absent";
}

/** A fact about stored bytes: which organization holds them, what their identity is, how long they are. */
export type ContentReference = {
  organizationId: string;
  /** sha256 hex, as the parser writes hashes. */
  contentHash: string;
  size: number;
};

/** A content identity without stored bytes behind it. */
export type ContentKey = Pick<ContentReference, "organizationId" | "contentHash">;

/**
 * Read failures are typed so a caller can distinguish "not here" from
 * "here but broken". A broken payload is never served as content; the
 * product rule is that the model may only describe code that was parsed.
 */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/**
 * The database contradicts itself about a file and its content: a `stored`
 * file with no content row under its hash, a status the schema does not
 * define, or bytes offered for storage that do not hash to the identity
 * they were fetched for. Never silenced into a typed null — null means
 * "genuinely absent", and a self-contradiction is not absence.
 */
export class ConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsistencyError";
  }
}

/**
 * The database security gate rejected bytes that were quarantined while a
 * writer or GitHub backfill was in flight. The message is deliberately
 * generic and safe to surface in diagnostics.
 */
export class ContentExcludedError extends Error {
  constructor() {
    super("content excluded by security policy");
    this.name = "ContentExcludedError";
  }
}

/** The store, in the shape callers use. Implemented in store.ts; the pipeline and the read path call it, both through lib/content. */
export interface ContentStore {
  /**
   * Store bytes under their own hash. Idempotent: storing the same body
   * again is a no-op, never an overwrite, and returns the same identity.
   */
  putContents(organizationId: string, content: Uint8Array): Promise<ContentReference>;

  /**
   * Store several bodies in one conflict-safe request, hashing them here and
   * collapsing identical bodies to one row. The caller owns chunking.
   */
  putContentsBatch(organizationId: string, writes: readonly ContentWrite[]): Promise<ContentWriteResult[]>;

  /**
   * The exact bytes, verified against their hash and size before being
   * returned; null when the organization holds no such content.
   */
  getContent(organizationId: string, contentHash: string): Promise<Uint8Array | null>;

  /** Whether the organization holds content for this hash, without reading its bytes. */
  existsContent(organizationId: string, contentHash: string): Promise<boolean>;
}

/**
 * The garbage collector's contract, implemented in `lib/content/gc.ts`.
 * Deletes file_contents rows of organizations whose hash no files row
 * references, with a grace period and atomic database-side check-and-delete.
 */
export type { GcOptions, GcStats } from "./gc.ts";
