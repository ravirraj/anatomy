/**
 * Repository-adaptive concept discovery — types (Phase 3).
 *
 * A ConceptIndex is built from the repository's own indexed data
 * (symbols, routes, edges, file paths) rather than from hardcoded glossaries.
 * All IDs are deterministic: given the same analysisId and the same
 * normalized term the same ID is produced on every run.
 *
 * No database migration is required: the index lives in memory and is
 * rebuilt from the tables that already exist (files, symbols, routes, edges).
 */

// ── Concept identity ─────────────────────────────────────────────────────────

/**
 * Stable, deterministic identifier for a discovered concept.
 * Format: `cncpt:<analysisId-prefix8>:<normalizedName>`
 * Example: `cncpt:a1b2c3d4:authentication`
 *
 * Derived from analysisId + normalized concept name using a simple
 * deterministic function — no random UUID-v4.
 */
export type ConceptId = string;

// ── Evidence produced by concept discovery ────────────────────────────────────

/**
 * How a piece of evidence was attached to a concept.
 * Ordered from strongest to weakest signal.
 */
export type ConceptEvidenceKind =
  /** Symbol name (or subtoken) exactly matches the concept's normalized terms. */
  | "symbol-exact"
  /** A route path segment exactly matches the concept's normalized terms. */
  | "route-exact"
  /** A file-path segment or filename exactly matches the normalized terms. */
  | "path-exact"
  /** A directory name exactly matches the normalized terms. */
  | "directory-exact"
  /** Co-occurrence: the term appears repeatedly in hash-verified source text. */
  | "source-cooccurrence"
  /** The file is in the same import cluster as other concept members. */
  | "cluster-membership";

/**
 * One piece of concrete evidence that associates a file with a concept.
 * Never fabricated: every piece names the exact source it came from.
 */
export type ConceptEvidence = {
  kind: ConceptEvidenceKind;
  /** Repo-relative file path. */
  filePath: string;
  /**
   * The specific term or token that produced this evidence
   * (e.g. "AuthService", "authentication", "/auth/login").
   */
  matchedTerm: string;
  /**
   * Relationship provenance: "direct" means the evidence came from the file's
   * own symbols/routes/path; "indexed" means it came via a graph edge that
   * exists in the analysis's edges table; "derived" means it was inferred from
   * inspected source text.
   */
  provenance: "direct" | "indexed" | "derived";
};

// ── Relationships between concepts ───────────────────────────────────────────

/**
 * How two concepts are related.
 * Relationship provenance matches the retrieval engine's terminology:
 * - indexed: backed by an edge row in the analysis's edges table
 * - derived: inferred from file co-imports or shared directory structure
 */
export type ConceptRelationshipKind =
  | "shares-files"    // both concepts have overlapping file membership
  | "imports"         // concept A's files import concept B's files (indexed)
  | "co-located";     // both concepts share a common directory

export type ConceptRelationship = {
  fromId: ConceptId;
  toId: ConceptId;
  kind: ConceptRelationshipKind;
  provenance: "indexed" | "derived";
  /** Number of file-pairs or edges that justify this relationship. */
  weight: number;
};

// ── A discovered concept ─────────────────────────────────────────────────────

export type RepositoryConcept = {
  /** Deterministic identifier (never UUID-v4). */
  id: ConceptId;
  /**
   * Human-readable display name: the most frequent/representative normalized
   * term in this concept's evidence. E.g. "authentication", "payment",
   * "background-jobs".
   */
  displayName: string;
  /**
   * All normalized terms that describe this concept, ordered by frequency.
   * These are the tokens used for question-to-concept matching.
   * E.g. ["authentication", "auth", "login", "session", "jwt"]
   * — derived entirely from this repository's own symbols/paths/routes.
   */
  normalizedTerms: string[];
  /**
   * Files whose evidence contributed to this concept. Ordered by evidence
   * strength (strongest first). The concept index preserves this so retrieval
   * can prioritize the most central files.
   */
  fileIds: string[];
  filePaths: string[];
  /**
   * The architectural role recorded for each of this concept's files by the
   * existing indexed role data (files.file_roles), keyed by file ID.
   * Only files with an indexed role appear here — roles are never inferred
   * from file names. Downstream consumers use this to bind a concept file to
   * exactly the category matching its role, instead of affiliating every
   * concept file with every category the concept spans.
   */
  fileRoles: Record<string, string>;
  /** The supporting evidence for each file membership. */
  evidence: ConceptEvidence[];
  /**
   * Confidence in [0, 1] derived from the number and quality of evidence
   * pieces. A concept with evidence from symbols + routes + paths > pure
   * path-only evidence. Used to filter out spurious single-file clusters.
   */
  confidence: number;
  /**
   * Analysis-relative evidence category names derived from the concept's own
   * files — not from a hardcoded glossary. These are role labels from the
   * existing `lib/roles.ts` system (e.g. "controller", "middleware", "service")
   * found among the concept's files. Used for adaptive coverage evaluation.
   */
  discoveredCategories: string[];
  /** Relationships to other discovered concepts. */
  relationships: ConceptRelationship[];
};

// ── The full index ────────────────────────────────────────────────────────────

export type ConceptIndex = {
  analysisId: string;
  /**
   * All discovered concepts, ordered by confidence descending.
   * A concept with zero files is never stored.
   */
  concepts: RepositoryConcept[];
  /**
   * Inverted index: fileId → concept IDs. Used for O(1) lookup of which
   * concepts a file belongs to during retrieval.
   */
  fileIdToConcepts: Map<string, ConceptId[]>;
  /**
   * Inverted index: normalized term → concept IDs. Used for O(1) lookup
   * of which concepts a query token matches.
   */
  termToConcepts: Map<string, ConceptId[]>;
  /** Wall-clock ms to build the index (for performance monitoring). */
  buildMs: number;
};

// ── Question-to-concept mapping ───────────────────────────────────────────────

/**
 * How a query token matched a discovered concept.
 * Ordered from strongest to weakest.
 */
export type ConceptMatchReason =
  | "exact-term"        // query token is exactly a concept's normalizedTerm
  | "subtoken-match"    // a subtoken of the query matches a concept term
  | "family-match"      // same word family (sameFamily() === true)
  | "glossary-fallback";// existing glossary synonym matched a concept term

export type ConceptMatch = {
  concept: RepositoryConcept;
  queryToken: string;
  reason: ConceptMatchReason;
  /** The specific concept term that matched. */
  matchedTerm: string;
  /**
   * Score in [0, 100]: used to rank multiple matching concepts for a single
   * query token. Exact > subtoken > family > glossary-fallback, weighted
   * by concept confidence.
   */
  score: number;
};

export type QuestionConceptMapping = {
  /** The original query. */
  query: string;
  /** Per-token matches (token → ranked matching concepts). */
  matches: Map<string, ConceptMatch[]>;
  /**
   * Top-ranked concepts across all query tokens, deduplicated and sorted by
   * combined score. These drive adaptive coverage and retrieval expansion.
   */
  topConcepts: RepositoryConcept[];
};
