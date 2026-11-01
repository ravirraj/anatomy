# Source Retention Security Remediation

Status: approved design; implementation is phased. Phase 1 is the only phase implemented by the accompanying change.

## Invariants

- Approved content remains the exact original bytes addressed and verified by SHA-256.
- Redacted bytes are never represented as the original source or stored under its hash.
- `excluded` and `legacy_unclassified` content never trigger GitHub backfill.
- Quarantine is organization-scoped and stores no source payload.
- No source or detected secret value may appear in application logs, diagnostics, or telemetry.
- Historical data is untrusted until it has been remediated and re-indexed.

## Implementation phases

### 1. Security state and atomic quarantine gate

Add `stored`, `absent`, `excluded`, and `legacy_unclassified` states; mark existing rows legacy-unclassified; add a service-only quarantine tombstone; and serialize content storage, file-state finalization, and quarantine with a common transaction advisory lock. Tighten member reads to explicitly approved `stored` references. This phase does not classify files or delete historical data.

Acceptance criteria:

- Existing rows migrate to `legacy_unclassified` without deleting payloads.
- `excluded` and `legacy_unclassified` reads return no content and perform no GitHub request.
- In either ordering of concurrent quarantine and storage, a committed quarantine leaves no content row and all matching file rows are `excluded`.
- GitHub backfill cannot finalize or cache content after quarantine wins the shared lock.
- Approved stored bytes retain exact SHA-256 and size verification.
- Quarantine metadata is unavailable to `anon` and `authenticated` roles.

### 2. Central classifier and versioned HMAC

Route every extractor input through one versioned classification boundary. Apply documented path rules and bounded value-shape detectors before content storage or parsing. Whole-file exclusion is the initial policy; structured omission is allowed only for explicitly reviewed non-value facts such as environment-variable names.

Secret detection is risk reduction, not a proof of universal detection. Encoded, split, encrypted, domain-specific, low-entropy, or novel secret formats can evade heuristics. High-entropy identifiers, fixtures, hashes, and generated data can create false positives. Each detector must publish its scope, test corpus, reason code, confidence, and version. False positives exclude the whole file until a reviewed policy change; they are never silently converted into redacted source.

Use a dedicated HMAC-SHA-256 key family used only for quarantine fingerprints. Configuration names must encode an integer key version, and one version is designated current. Rotation is staged:

1. Deploy readers with both old and new keys and select the new version for writes.
2. Recompute organization-bound fingerprints from the service-only raw hashes in quarantine, under the shared content lock.
3. Verify all rows use the new version and every application instance has reloaded configuration.
4. Retire the old key after the operational rollback window.

Keys, raw hashes, source paths, detector samples, and source values must never be logged. Key loss does not affect approved source integrity because SHA-256 remains the content identity; it only prevents reproducing fingerprints for that key version.

### 3. Derived-data release gate

Screen symbols, signatures, documentation, manifest fields, dependency constraints and URLs, entry-point details, configuration facts, routes, and diagnostics before persistence. Store only approved structured facts. Error reporting uses reason codes and counts, never offending lines or values.

Acceptance requires canaries to be absent from every derived table and all captured logs/errors.

### 4. Serving, cache, citation, and telemetry controls

Add an organization security epoch to process, AI, and browser cache keys; reject stale epochs; enforce approved evidence in retrieval and citations; and permit only source-free, proven-sanitized external telemetry. Source-bearing LangSmith/OpenAI tracing is disabled.

Acceptance requires excluded and legacy evidence to be unreachable through retrieval, citations, caches, model input, browser storage, and external trace payloads.

### 5. Historical remediation tooling and rehearsal

Build inventory, quarantine, purge, re-index, cache invalidation, and verification tooling with dry-run output. Rehearse the complete procedure on a disposable production-like database restored from representative data. Record row counts, lock behavior, duration, rollback limits, backup retention, and external-provider deletion status.

No production deletion is authorized by this phase.

### 6. Approved production remediation

After explicit approval, pause ingestion and Q&A, quarantine first, purge retained source and derivatives, advance security epochs, restart all instances, re-index, and run canary verification. Database/code rollback is forward-only after destructive cleanup; deleted sensitive payloads must not be restored as a rollback mechanism.

## Dependency graph

Phase 1 is foundational. Phase 2 depends on Phase 1. Phase 3 depends on Phase 2. Phase 4 depends on Phases 1–3. Phase 5 depends on Phases 1–4. Phase 6 depends on a successful Phase 5 rehearsal and separate production-deletion approval.

## Historical and deletion policy

The Phase 1 migration changes existing file state to `legacy_unclassified` and hides those payloads from member reads, but deliberately retains the content rows for later measured remediation. Security deletion is quarantine-first and immediate once authorized; ordinary unreferenced-content GC retains its existing grace period. Backups and external telemetry are not considered clean until deletion is confirmed or documented retention has expired.
