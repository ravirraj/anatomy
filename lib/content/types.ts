// The shape of source-content storage, shared by its callers. The database
// schema it talks to is migration 20261030040722: content addressed by
// (organization, sha256), immutable once written.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types.ts";

export type Db = SupabaseClient<Database>;

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

/** The store, in the shape callers use. Implemented in store.ts; the pipeline and the read path call it, both through lib/content. */
export interface ContentStore {
  /**
   * Store bytes under their own hash. Idempotent: storing the same body
   * again is a no-op, never an overwrite, and returns the same identity.
   */
  putContents(organizationId: string, content: Uint8Array): Promise<ContentReference>;

  /**
   * The exact bytes, verified against their hash and size before being
   * returned; null when the organization holds no such content.
   */
  getContent(organizationId: string, contentHash: string): Promise<Uint8Array | null>;

  /** Whether the organization holds content for this hash, without reading its bytes. */
  existsContent(organizationId: string, contentHash: string): Promise<boolean>;
}

/**
 * The garbage collector's contract, to be implemented by a later phase
 * (TODO 3.4, "Garbage collection of orphaned content"). Nothing here calls
 * it yet, and this file deliberately contains no deletion code: removing a
 * row is correct only when no lives files row references its hash any more,
 * which needs the reverse-lookup read the migration's
 * files (organization_id, hash) index serves.
 *
 * <T> deleteOrphanedContents(db: Db): Promise<number>
 * — deletes file_contents rows of organizations whose hash no files row
 * references, returning how many it removed.
 */
