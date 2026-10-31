/**
 * Public barrel for the concept discovery subsystem.
 *
 * Import from here rather than from individual files.
 */
export type {
  ConceptEvidence,
  ConceptEvidenceKind,
  ConceptId,
  ConceptIndex,
  ConceptMatch,
  ConceptMatchReason,
  ConceptRelationship,
  ConceptRelationshipKind,
  QuestionConceptMapping,
  RepositoryConcept,
} from "./types.ts";

export {
  buildConceptIndex,
  conceptId,
  type DiscoveryEdge,
  type DiscoveryFile,
  type DiscoveryInput,
  type DiscoveryRoute,
  type DiscoverySymbol,
} from "./discovery.ts";

export { matchConceptsForQuery } from "./mapping.ts";
