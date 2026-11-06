# Stable Release Readiness — Subscription Change Quote (SCQ)

**Status: QUALIFICATION IN PROGRESS — nothing in this document is a
stability claim.** The only published artifact is
`@agorail-labs/scq-reference@0.6.2-experimental.1`, implementing the
v0.6.2 experimental specification. This document defines the
proposed stable core, reconciles the three version lines, and lists
every known blocker with an owner and a completion criterion. Part
of the Agorail Stable Release Engineering Program (November 2026).

## 1. The three version lines (read first)

| Line | Identifier | State |
|---|---|---|
| Specification | SCQ v0.6.2 (`spec/scq-v0.6.2-spec.md`) | Current experimental normative spec; frozen surface under the protocol freeze guard |
| Published package | `@agorail-labs/scq-reference@0.6.2-experimental.1` | The only artifact external consumers can install; predates the v0.7 source changes below |
| Repository source | v0.7 development line on `main` | Contains merged changes **not in the published package**: the Issue #64 envelope-naming canonicalization (`maxImmediateNetDecrease`; `maxImmediateCreditDecrease` retained as a deprecated alias), the durable-store verified-recovery work (#51/#45), and the source-only MSE–SCQ bridge (#69) |

**Reconciliation rule for 1.0:** the stable scope is defined
against the *published* package's behavior. Each v0.7 source change
enters stable scope only when it is enumerated in the API
compatibility report, covered by compatibility tests against the
published artifact, and given a migration note. The naming change is
the canonical example: a 1.0 envelope reader must accept both
spellings exactly as the v0.7 source does (both-in-one-envelope
refused as ambiguous; stored records never rewritten), and the
migration guide must say so.

A stable package version does **not** rename the specification:
the spec remains v0.6.2 (plus any separately ratified v0.7 spec work
through the existing governance process). Package, spec, source,
and documentation versions are distinct and are never conflated.

## 2. Proposed stable core

### 2.1 In scope — supported public contracts

| Surface | Exports (published package) | Contract summary |
|---|---|---|
| Core types | `export *` from `core/types`: subscription snapshots and proposals, quote structure, acceptance envelope, receipt, reconciliation types | Financial amounts are integer minor units with explicit currency; **UNKNOWN is a distinct state, never zero**; determinacy is gated — a non-deterministic quote is refused before any mutation (`QUOTE_NOT_DETERMINISTIC`). |
| Acceptance envelope | envelope types + engine checks | Pre-dispatch gate: immediate/recurring bounds checked arithmetically against the quote; expired quotes rejected; missing acceptance fails closed. |
| Durable store | `DurableQuoteStore`, `DurableStoreError`, `DurableRecoveryError`, `DispatchBlockedError`, `ResolutionEvidenceError`, `createProviderEvidenceVerifier`, `RESOLUTION_EVIDENCE_MAX_AGE_MS`, associated stored-attempt/resolution types | SQLite (WAL) durable attempt fencing; replay of a settled intent returns the original recorded receipt with **no second dispatch**; INDETERMINATE resolution requires trusted, fresh, attributable provider evidence — recovery can never fabricate a verified receipt. |
| Mutation coordination | `DurableMutationCoordinator` | The commit path: attempt claim → envelope gate → single dispatch → durable receipt → replay/reconciliation. |
| Post-commit state verification | `verifyPostCommitState` | Verifies *target-state conformance* of observed state. It does **not** verify authorization preservation, and identical observed state is never treated as proof that a specific operation executed. |
| In-memory store | `QuoteStore`, `establishVerification`, evidence helpers | Non-durable reference behavior; supported for tests and embedding where durability is the caller's own layer. |
| Provider adapters (shape) | `ChargebeeAdapter`, `StripeAdapter`, `PaddleAdapter`, `ZuoraAdapter` | Provider-neutral core boundary: adapters translate provider records into core evidence. Supported as *translation layers over caller-supplied transports*. |
| Simulators | `ChargebeeSim`, `StripeSim`, `PaddleSim`, `ZuoraSim` | Deterministic test doubles. Supported **as simulators only** — behavior parity with any real provider is explicitly not claimed. |

### 2.2 The four supported mutation categories

Quantity, plan, cadence, and cancellation changes — as quote →
accept → commit semantics over the surfaces above. Categories
outside these four are out of stable scope.

### 2.3 Explicitly excluded from the stable core

- **Real provider commit adapters and live dispatch.** The
  repository's live pilot code (`src/live/`) is excluded from the
  published tarball by the package `files` field and stays excluded.
  No live Chargebee (or any provider) mutation is a supported use.
- Exactly-once provider execution guarantees; atomic cross-provider
  or cross-ledger transactions. (SCQ provides *durable replay of its
  own recorded receipt*, which is a different, narrower claim.)
- UCP conformance or endorsement of any kind.
- The source-only MSE–SCQ business-intent bridge (#69): experimental
  source, in neither published package, excluded from 1.0 unless a
  separate review promotes it (see its open questions in the bridge
  audit: separate-ledger crash gaps, orphan-claim recovery,
  namespace isolation evidence).
- `verifyPostCommitState` as an authorization or execution proof
  (see §2.1 note).

### 2.4 Documented trust limitations carried into stable scope

These are not blockers to hide; they are part of the contract:

- **G-01 (ratified, Issue #21 dispositions):** the core trusts
  adapter-established classifications and does not independently
  authenticate provider events. Authenticity of provider evidence is
  the integrating application's responsibility, bounded by the
  evidence-verifier requirements for INDETERMINATE resolution.
- **Conformance PARTIALs (v0.6.2 audit, 72 IMPLEMENTED / 3 PARTIAL /
  0 BLOCKED):** V62-DET-08 (descriptive), V62-EVD-01 (= G-01),
  V62-SV-02 (narrowed) — each must be stated in the 1.0 limitations
  exactly as scoped in the audit.

## 3. Behavioral guarantees the stable core must evidence

1. Units and currency preserved end-to-end; no float money math.
2. UNKNOWN ≠ 0 in every comparison, bound check, and report.
3. Missing or expired acceptance ⇒ refusal before dispatch.
4. Replay of a settled intent ⇒ original receipt, zero additional
   dispatches (callback-counted in tests).
5. Concurrent processes cannot both pass the durable attempt fence.
6. Corrupted or unavailable persistence ⇒ fail closed, never an
   unsafe automatic retry.
7. Recovery never fabricates a verified receipt; unresolved attempts
   stay INDETERMINATE until trusted evidence resolves them.
8. Identical observed state is not proof a specific operation
   executed (attribution precedes classification).

## 4. Blockers

| ID | Blocker | Owner | Completion criterion |
|---|---|---|---|
| B-SCQ-1 | Published-vs-source naming divergence (`maxImmediateCreditDecrease` published; `maxImmediateNetDecrease` canonical in v0.7 source) | This program (Phase 2) | Compatibility tests prove a candidate build accepts both spellings per the alias rules; migration guide documents the rename |
| B-SCQ-2 | §6.16 amendment route undecided (fold into v0.7 vs separate amendment) | Maintainer (governance decision, PR #60 options) | Decision recorded; stable scope states which text governs |
| B-SCQ-3 | Local `npm pack` tarballs do not reproduce the published checksum pins; cause **unexplained** | This program (Phase 4/8) | Release process uses only the CI-attested route that produced the published pins; RC artifacts produced and hash-verified through that route |
| B-SCQ-4 | Supported Node matrix (22/24/26 LTS) not yet validated at a candidate commit | This program (Phase 5) | Full suite + consumer smoke green on all three, transcripts recorded |
| B-SCQ-5 | No public API snapshot / compatibility tests against the published artifact | This program (Phase 2) | Snapshot + backward-compatibility tests in CI; unreviewed surface change fails CI |
| B-SCQ-6 | No independent evaluation of the stable candidate | External reviewers; maintainer to invite | ≥2 substantive evaluations with reproducible evidence, at least one adversarial |
| B-SCQ-7 | Maintainer approval of the stable scope itself | Maintainer (Arjun) | Explicit approval of §2 as the 1.0 contract |

## 5. What "stable" would and would not mean

If the gates pass, `1.0.0` would mean: the §2 API keeps
semantic-versioning compatibility, the §3 behaviors are
regression-tested, the §2.4 limitations are documented as contract,
and security fixes land per the maintenance policy. It would never
mean production billing certification, provider endorsement, or
permission to dispatch live mutations.
