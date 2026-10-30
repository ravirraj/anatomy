// Stores and reads source-file contents, addressed by the hash the parser
// computed. Rows never rewritten: putting a body a second time is a no-op,
// and the schema refuses updates (migration 20261030040722). The database's
// row policies do the tenant isolation; this module passes organization_id
// the way every writer in this repository does (lib/supabase/admin.ts), it
// does not filter by it as if that were a boundary.

import { createHash } from "node:crypto";
import { MAX_FILE_BYTES } from "../parser/walk.ts";
import { IntegrityError, type ContentKey, type ContentReference } from "./types.ts";
import type { Db } from "./types.ts";

export { IntegrityError } from "./types.ts";
export type { ContentKey, ContentReference } from "./types.ts";

/** The parser sets the bound twice over — once here, once in the schema. */
export const MAX_CONTENT_BYTES = MAX_FILE_BYTES;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isContentHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/**
 * bytea over PostgREST travels as a hex literal ("\x…"); that is the wire
 * format, not a storage choice. The database stores raw bytes; between the
 * client and Postgres only the JSON text form exists.
 */
function toPayload(content: Uint8Array): string {
  return "\\x" + Buffer.from(content).toString("hex");
}

function fromPayload(value: unknown): Uint8Array {
  if (typeof value === "string") {
    // PostgREST's bytea text: "\x<hex>". Lower-case hex; case-insensitive to read.
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new IntegrityError("stored payload is not a bytea hex literal");
    return new Uint8Array(Buffer.from(hex, "hex"));
  }
  if (value instanceof Uint8Array) return value;
  throw new IntegrityError("stored payload arrived in neither the bytea text form nor bytes");
}

/**
 * Writes bytes under their own hash. The hash comes from the bytes, never
 * from the caller; the row's payload is the whole bytes, never a decode of
 * them; an identical body already stored is left exactly as it is.
 */
export async function putContents(db: Db, organizationId: string, content: Uint8Array): Promise<ContentReference> {
  if (content.byteLength > MAX_CONTENT_BYTES) {
    throw new Error(`A file over ${MAX_CONTENT_BYTES} bytes is skipped by the parser and never stored (${content.byteLength} bytes given)`);
  }
  const contentHash = sha256(content);
  const { error } = await db
    .from("file_contents")
    // Upsert with ignoreDuplicates, as every conflict-safe write here does
    // (see lib/pipeline/submit.ts): an existing row is left as it is — the
    // first write of a body wins — and no error is raised.
    .upsert(
      { organization_id: organizationId, content_hash: contentHash, payload: toPayload(content), size: content.byteLength },
      { onConflict: "organization_id,content_hash", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Storing content failed: ${error.message}`);
  return { organizationId, contentHash, size: content.byteLength };
}

/** One row of file_contents, as the client sees it. */
type StoredContent = { payload: unknown; size: number };

function verifiedContent(key: ContentKey, row: StoredContent): Uint8Array {
  const bytes = fromPayload(row.payload);
  if (sha256(bytes) !== key.contentHash) throw new IntegrityError(`stored bytes hash differently than ${key.contentHash}, the identity they are stored under`);
  if (bytes.byteLength !== row.size) {
    throw new IntegrityError(`stored bytes are ${bytes.byteLength} long but the row says ${row.size}, for ${key.contentHash}`);
  }
  return bytes;
}

/**
 * The exact bytes the parser read, or null when the organization holds no
 * such content. The read verifies itself — hash against the identity,
 * length against the row's own record — and throws rather than pass a
 * changed payload along as if it were the file.
 */
export async function getContent(db: Db, organizationId: string, contentHash: string): Promise<Uint8Array | null> {
  if (!isContentHash(contentHash)) throw new IntegrityError(`not a content hash: ${contentHash}`);
  const { data, error } = await db
    .from("file_contents")
    .select("payload, size")
    .eq("organization_id", organizationId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (error) throw new Error(`Reading content failed: ${error.message}`);
  if (!data) return null;
  return verifiedContent({ organizationId, contentHash }, data);
}

/** Whether the bytes are held, without reading them: size is selected, payload is not. */
export async function existsContent(db: Db, organizationId: string, contentHash: string): Promise<boolean> {
  if (!isContentHash(contentHash)) throw new IntegrityError(`not a content hash: ${contentHash}`);
  const { data, error } = await db
    .from("file_contents")
    .select("size")
    .eq("organization_id", organizationId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (error) throw new Error(`Checking for content failed: ${error.message}`);
  return data !== null;
}
