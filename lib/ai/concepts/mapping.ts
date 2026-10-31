/**
 * Question-to-concept mapping (Phase 4).
 *
 * Maps natural-language query tokens to discovered repository concepts using:
 *   1. Exact lexical match against concept's normalizedTerms.
 *   2. Identifier subtoken match (e.g. "AuthService" → "auth" matches "authentication").
 *   3. Word-family match via sameFamily() from retrieval.ts.
 *   4. Existing glossary as fallback (last resort, never creates false matches
 *      for strongly-typed concepts).
 *
 * Semantic similarity is NOT used here — the existing infrastructure does not
 * include an embedding index, and deterministic lexical matching is sufficient
 * and reproducible.
 *
 * False-association prevention:
 *   - Generic verbs (create, handle, …) and stop-words from the planner are
 *     never used as match keys.
 *   - A glossary fallback only fires when NO direct/subtoken/family match exists.
 *   - Concept confidence gates weak matches: a glossary-fallback match against
 *     a low-confidence concept is discarded.
 *   - Each ConceptMatch records exactly why it matched — fully explainable.
 */

import { identifierSubtokens, sameFamily, tokenVariants } from "../retrieval.ts";
import type {
  ConceptIndex,
  ConceptMatch,
  ConceptMatchReason,
  QuestionConceptMapping,
  RepositoryConcept,
} from "./types.ts";

// ── Score constants ───────────────────────────────────────────────────────────

const MATCH_SCORE: Record<ConceptMatchReason, number> = {
  "exact-term": 100,
  "subtoken-match": 75,
  "family-match": 55,
  "glossary-fallback": 30,
};

/** Concepts below this confidence threshold are not matched via weak signals. */
const MIN_CONFIDENCE_FOR_WEAK_MATCH = 0.25;

/**
 * Maps query tokens to discovered concepts.
 *
 * @param queryTokens  - stop-filtered tokens from extractQueryTokens()
 * @param genericTokens - tokens the planner classified as generic verbs
 * @param index        - the ConceptIndex for this analysis
 */
export function matchConceptsForQuery(
  queryTokens: string[],
  genericTokens: Set<string>,
  index: ConceptIndex,
): QuestionConceptMapping {
  const query = queryTokens.join(" ");
  const matches = new Map<string, ConceptMatch[]>();

  for (const token of queryTokens) {
    // Generic verbs must not be used as concept-matching keys
    if (genericTokens.has(token)) continue;
    if (token.length < 2) continue;

    const tokenMatches: ConceptMatch[] = [];
    const seenConceptIds = new Set<string>();

    // Strategy 1 + 2: Expand the token into variants (original, stem, glossary)
    // and check each against concept normalizedTerms.
    // Also expand the token's own identifier subtokens.
    const candidateTerms = new Map<string, ConceptMatchReason>();

    // Token itself
    candidateTerms.set(token, "exact-term");

    // Subtokens of the token (handles camelCase query words)
    for (const sub of identifierSubtokens(token)) {
      if (!candidateTerms.has(sub)) candidateTerms.set(sub, "subtoken-match");
    }

    // Glossary variants (existing infrastructure, used as fallback)
    for (const { text, kind } of tokenVariants(token)) {
      if (text === token) continue; // already added
      const reason: ConceptMatchReason = kind === "glossary" ? "glossary-fallback" : "subtoken-match";
      if (!candidateTerms.has(text)) candidateTerms.set(text, reason);
    }

    // Match each candidate term against the index
    for (const [candidate, candidateReason] of candidateTerms) {
      // Exact lookup in the inverted index
      const conceptIds = index.termToConcepts.get(candidate);
      if (conceptIds) {
        for (const cid of conceptIds) {
          if (seenConceptIds.has(cid)) continue;
          const concept = index.concepts.find((c) => c.id === cid);
          if (!concept) continue;

          // Glossary fallback: only for reasonably confident concepts
          if (
            candidateReason === "glossary-fallback" &&
            concept.confidence < MIN_CONFIDENCE_FOR_WEAK_MATCH
          ) continue;

          seenConceptIds.add(cid);
          const baseScore = MATCH_SCORE[candidateReason];
          tokenMatches.push({
            concept,
            queryToken: token,
            reason: candidateReason,
            matchedTerm: candidate,
            score: Math.round(baseScore * concept.confidence + baseScore * 0.5),
          });
        }
      }

      // Strategy 3: Word-family match across all concept terms
      for (const concept of index.concepts) {
        if (seenConceptIds.has(concept.id)) continue;
        const familyTerm = concept.normalizedTerms.find((t) => sameFamily(t, candidate));
        if (!familyTerm) continue;

        // Family match: requires reasonable concept confidence
        if (concept.confidence < MIN_CONFIDENCE_FOR_WEAK_MATCH) continue;

        seenConceptIds.add(concept.id);
        const baseScore = MATCH_SCORE["family-match"];
        tokenMatches.push({
          concept,
          queryToken: token,
          reason: "family-match",
          matchedTerm: familyTerm,
          score: Math.round(baseScore * concept.confidence + baseScore * 0.3),
        });
      }
    }

    // Sort matches for this token by score descending
    tokenMatches.sort((a, b) => b.score - a.score || a.concept.displayName.localeCompare(b.concept.displayName));

    if (tokenMatches.length > 0) {
      matches.set(token, tokenMatches);
    }
  }

  // Deduplicate and rank top concepts across all tokens
  const conceptScores = new Map<string, { concept: RepositoryConcept; totalScore: number; tokenCount: number }>();
  for (const [, tokenMatches] of matches) {
    for (const m of tokenMatches) {
      const existing = conceptScores.get(m.concept.id);
      if (existing) {
        existing.totalScore += m.score;
        existing.tokenCount += 1;
      } else {
        conceptScores.set(m.concept.id, {
          concept: m.concept,
          totalScore: m.score,
          tokenCount: 1,
        });
      }
    }
  }

  const topConcepts = [...conceptScores.values()]
    .sort((a, b) =>
      // Primary: multi-token matches rank above single-token
      b.tokenCount - a.tokenCount ||
      // Secondary: total score
      b.totalScore - a.totalScore ||
      // Tertiary: concept confidence
      b.concept.confidence - a.concept.confidence ||
      a.concept.displayName.localeCompare(b.concept.displayName),
    )
    .slice(0, 8) // top 8 concepts per question
    .map((e) => e.concept);

  return { query, matches, topConcepts };
}
