# MSE v0.3.0 — Source Location and Verbatim Contracts

**Result: LOCATED — VERIFIED.** The actual MSE v0.3.0 normative text was found
and read at its release tag. All excerpts below are copied verbatim from that
tag's files. Nothing below is reconstructed from drafts, plan documents,
memory notes, or summaries.

Date of search: 2026-10-30 (America/Los_Angeles)

## 1. Identity and location

- **MSE = Mutation Safety Envelope**
- **Repo:** `arjun2075/mutation-safety-envelope`
  - GitHub: https://github.com/arjun2075/mutation-safety-envelope
  - Repo description (GitHub API): "Experimental safety envelope for
    agent-initiated mutations to existing commercial state."
- **Tag:** `v0.3.0`
  - Tag object / commit: `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`
    (`refs/tags/v0.3.0`, GitHub API `git/refs/tags/v0.3.0`)
  - Release (GitHub API): tag `v0.3.0`, name
    "MSE v0.3.0 — Admission Dependencies and Live Repair Witnesses",
    `prerelease: true`, published `2026-09-05T21:39:06Z`,
    target `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`
  - Other tags in the repo, for disambiguation: `v0.2.0`
    (`b97d9e2ff9fa32b62b42d86fba70de688d3b0416`), `v0.1.0`
    (`f625ab5227cd624cb2b40927c688778b686281a8`)
- **Primary file:** `spec/normative-spec.md` at tag `v0.3.0`
  (48,750 bytes in the tag tree)
  - URL form used by the author's own UCP #799 comment for other files at
    this tag: `https://github.com/arjun2075/mutation-safety-envelope/blob/v0.3.0/…`
- **Normative schema at the same tag:** `schema/mse-core.schema.json`
  (35,162 bytes)
- **Supporting files at the same tag cited below:**
  `docs/security-considerations.md`, `docs/ambiguities.md`

### The document's own version statement (verbatim, `spec/normative-spec.md`, header)

> # Mutation Safety Envelope (MSE) — Normative Specification
>
> **Version:** v0.3.0
> **Status:** Experimental / External Review Candidate
> **Conformance to:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords (MUST, SHOULD, MAY, etc.) are used as defined there.

> The normative artifact is [`/schema/mse-core.schema.json`](../schema/mse-core.schema.json).
> This document describes the rules that schema cannot express on its own,
> and the design rationale behind the schema's shape. Where this document and
> the schema disagree, treat that as a bug report against one of the two, not
> as license to pick whichever is convenient — file an issue.

> **v0.3.0 is a breaking revision of v0.2.0.** It retains v0.2.0's
> per-unit outcomes and read-based reconciliation, and adds the separate
> pre-dispatch admission boundary motivated by later comments in UCP
> Discussion #799.

Corroboration at the same tag: `package.json` has `"version": "0.3.0"`;
`README.md` header has "**Status:** Experimental / External Review Candidate — v0.3.0".

### How it was found / retrieved

1. Local workspace: no local clone of `mutation-safety-envelope` exists under
   `~/workspace` (git clones present are UCP, A2A, SCQ, etc.). Word-boundary
   grep for `MSE` in `~/workspace` (excluding `self_improvement` staging
   copies) found leads, not the spec itself:
   - `~/workspace/ucp-involvement/involvement-map.md` — Discussion #799 entry
     naming the `mutation-safety-envelope` repo and PRs.
   - `~/workspace/evidence/ucp-mse/arjun-authored/discussion_799_comments_comment_18309220.md`
     — author's 2026-09-05 comment: "I've published [MSE v0.3.0 as a
     prerelease](https://github.com/arjun2075/mutation-safety-envelope/releases/tag/v0.3.0)".
     Used **only as a search lead**, per instructions.
2. GitHub public API: `GET /users/arjun2075/repos?per_page=100` lists
   `mutation-safety-envelope`; `GET /repos/arjun2075/mutation-safety-envelope/tags`,
   `/releases`, and
   `/git/trees/b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1?recursive=1`
   confirmed the tag, release, and file tree above.
3. Retrieval: tarball for `refs/tags/v0.3.0` downloaded via the GitHub API
   and extracted to `/tmp/mse-v030/`; excerpts were copied from
   `/tmp/mse-v030/spec/normative-spec.md` (and, where labelled, the schema /
   docs at the same tag). A `git clone` over the SSH wrapper
   (`GIT_SSH=$HOME/workspace/bin/gh-ssh.sh`) was attempted first and failed
   with "Permission denied (publickey)"; the public API tarball is the
   retrieval that succeeded and was read.

### Anti-conflation warning (the prior verified failure)

The later draft at
`~/workspace/ucp-involvement/drafts/discussion-799-mse-enhancement-proposal.md`
describes the prototype at commit `f0339c2` (PR #6, post-v0.3.0 /
0.4.0-dev.0 line: satisfaction evidence, `passEvidence`,
`NOT_APPLICABLE`-adjacent discussion, required `AdmissionReport` in
`COMMIT_RESULT`). **None of that is in v0.3.0.** Verified by grep against the
v0.3.0 spec: no occurrence of `0.4.0`, `NOT_APPLICABLE`, `AdmissionReport`,
`passEvidence`, or `satisfaction` in `spec/normative-spec.md` at tag
`v0.3.0`. Do not use that draft for a v0.3.0 comparison.

## 2. Terminology mapping

MSE v0.3.0 does **not** contain sections literally titled "transition
contract", "snapshot contract", or "guarantee contract". The only
"… contract" heading in the spec is §4b, "The INDETERMINATE resolution
contract". The mapping used below is therefore:

| Requested contract | MSE v0.3.0 source |
|---|---|
| Transition contract | §1a (`CommittingUnit.transition`), §3 (Lifecycle), §3.1, §3.2 per-unit outcomes |
| Admission contract | §1d (Directional admission relations), §2 (admission as pre-dispatch gate), §3.2 (admission evaluation, `AdmissionRefusal`, witnesses) |
| Snapshot contract | §6 ("Snapshot and drift detection are provider-defined, not universal"), plus `commitConsistency` in `schema/mse-core.schema.json` |
| Guarantee contract | §4 ("Guarantee semantics"), §3.1 (EXACT rule), §3.2 (`APPLIED` / EXACT rule) |

## 3. Verbatim excerpts

### (a) Transition contract — §1a, §3, §3.1, §3.2

§1a, on what a unit's `transition` is:

> A `MutationQuote` therefore carries `units: CommittingUnit[]` — the
> complete set of independently committing units this quote proposes,
> **known no later than quote time**. Each `CommittingUnit` has:
>
> - an opaque, stable `unitRef`, unique within the quote;
> - a binding-scoped `unitLocator` that can identify the same domain unit
>   across a failure witness and a separately generated quote;
> - an opaque, binding-defined `transition` describing what this unit would
>   dispatch;
> - its own `effects: Effect[]`.

> A provider MUST NOT invent a unit identity only after execution — the
> purpose of fixing `unitRef`s at quote time is so a caller can check result
> coverage (§1b) against a set it already saw *before* committing, not
> discover the set only from the result.

§3, Lifecycle (verbatim diagram):

```text
MutationProposal → MutationQuote → CommitRequest → CommitResponse
       ▲                                      ├─ ADMISSION_REFUSED
       │                                      │    └─ witness → new proposal → new quote
       │                                      └─ COMMIT_RESULT → Receipt
       │                                              └─ Reconciliation (per INDETERMINATE unit)
       └──────────────────── amendment always re-enters here
```

§3.1, quoting must not itself commit, and transition preservation:

> A provider receiving a `MutationProposal` MUST return a `MutationQuote`
> that does not itself commit the requested commercial mutation described by
> `change`. Quoting MUST NOT be the mechanism by which the target resource's
> durable commercial terms (price, quantity, plan, itinerary, contract terms,
> etc.) actually change.

> Each quote MUST also preserve the opaque `transition` associated with
> every `CommittingUnit` and a binding-scoped `unitLocator`. The provider
> MAY retain the originating proposal internally (the reference provider
> does) so a binding hook can evaluate the exact submitted transition set.
> Core code MUST NOT parse transition/domain state vocabulary. The quoter
> and binding are responsible for mapping `MutationProposal.change` into
> quoted units, locators, transitions, effects, and relation declarations.

§3.2, the three legal per-unit transition outcomes on the `COMMIT_RESULT` branch:

> - **`APPLIED`** — this unit's mutation was applied. `committedEffects`
>   MUST be present and MUST NOT differ from this unit's quoted effects for
>   any effect whose `guarantee.mode` was `EXACT`. `refusalReason` and
>   `reconciliation` MUST be absent. (See §4.)
> - **`REFUSED`** — this unit's mutation was not applied. `refusalReason`
>   MUST be present. `committedEffects` and `reconciliation` MUST be absent.
> - **`INDETERMINATE`** — the provider cannot safely tell the caller whether
>   this unit's mutation applied (e.g. a network timeout after the request
>   reached the backend). `committedEffects` MUST be absent — a provider
>   MUST NOT claim effects it does not know occurred. `refusalReason` MUST
>   also be absent; `reconciliation` MUST be present (see §4b).

> One unit's outcome MUST NOT be inferred from another's.

### (b) Admission contract — §1d, §2, §3.2

§1d, "Directional admission relations are not atomic commit groups":

> A `MutationQuote` carries `admissionRelations: AdmissionRelation[]`, which
> MUST be present and MAY be empty. v0.3.0 defines one deliberately narrow
> relation type: `REQUIRES_COINCLUSION`.

> The relation declaration is stable quote material. It MUST NOT embed a
> quote-time list of currently missing units. Domain operations, resource
> states, and the rule deciding which scoped units are currently required
> belong to the binding. The binding evaluates those semantics against live
> state at admission (§3.2).

> `REQUIRES_COINCLUSION` means only that transitions must be submitted
> together to pass a pre-dispatch gate. It does **not** make the units an
> atomic transaction. Once admission passes, each unit still receives its
> own `UnitResult`; one can be `APPLIED` while a required companion is
> `REFUSED` or `INDETERMINATE`. A binding that must prevent that economic
> outcome needs a stronger execution/transaction guarantee outside this
> relation.

§2, admission's status in the model:

> Admission validity is an additional **pre-dispatch gate**, not a fourth
> commit outcome and not a fourth effect guarantee. A known
> `ADMISSION_REFUSED` response proves that this submission dispatched no
> commercial mutation. If dispatch may have occurred, the provider MUST use
> the per-unit determinacy model (including `INDETERMINATE` and
> reconciliation) instead of reporting a clean admission refusal.

§3.2, admission evaluation and refusal / witness rules:

> After quote-level safety checks and before dispatching any commercial
> mutation, a provider MUST evaluate every applicable quote-declared
> `AdmissionRelation` against the submitted transitions and current binding
> state. The evaluation itself MUST be observational with respect to the
> commercial mutation: a binding MUST NOT dispatch any quoted transition from
> inside an admission evaluator. A provider MAY evaluate several relations
> together, but a returned failure for one relation MUST NOT claim that
> repairing it makes every other relation—or the whole request—admissible.

> `CommitResponse` has exactly one branch:
>
> - `ADMISSION_REFUSED` carries an `AdmissionRefusal` and means this
>   submission dispatched **no** commercial mutation;
> - `COMMIT_RESULT` carries the v0.2.0 `CommitResult` with unchanged complete
>   per-unit coverage and determinacy semantics.

> Every failed relation MUST identify a relation declared by the quote and
> carry exactly one explicit witness disposition:
>
> - `COMPLETE` MUST include a non-empty `requiredTransitions` list that is
>   sufficient to construct an amendment for **that relation at that
>   evaluated state**;
> - `PARTIAL` MUST include a non-empty informative list, but the provider
>   MUST NOT advertise it as sufficient for local repair;
> - `UNAVAILABLE` carries no transition list because the provider cannot
>   supply trustworthy repair information;
> - `NOT_REPAIRABLE` carries no transition list because adding transitions
>   cannot repair this failure.

> A caller using a `COMPLETE` witness MUST construct a new
> `MutationProposal` and obtain a new `MutationQuote`. It MUST NOT append an
> unquoted unit to the old `CommitRequest`.

Author's own v0.3.0 announcement (UCP #799 comment, 2026-09-05 — context, not
normative text) summarised this boundary as: "a complete witness removes the
discovery read, but v0.3.0 still requires an amended proposal and a new
quote. It does not authorize additional transitions or modify the original
quote. Passing admission also does not imply atomic execution across units."

### (c) Snapshot contract — §6, and schema `commitConsistency`

§6, "Snapshot and drift detection are provider-defined, not universal" (full section):

> `MutationQuote.snapshot` is opaque, provider-defined precondition material.
> The core does not require:
>
> - a single, shared snapshot/token scheme across providers or profiles;
> - that every write path into a resource (not only MSE-issued commits)
>   update the same tracked value.
>
> A provider or adapter that declares `commitConsistency` other than `NONE`
> MUST document, in its own adapter documentation (not in the core schema),
> what `snapshot` actually contains and what mechanism detects drift against
> it. This is a deliberate scope boundary, not an oversight: MSE standardizes
> *that* a provider can declare a drift-detection consistency level and *what
> the caller should expect* (`SNAPSHOT_REQUIRED` refuses on mismatch,
> `SNAPSHOT_ADVISORY` does not), without standardizing *how* drift detection
> is implemented, since that is inherently tied to each provider's own
> storage and concurrency model.

§6 also states: "`commitConsistency` currently applies at the whole-quote level, not
per-unit".

§1 (Scope) on snapshot-adjacent exclusions:

> - HTTP conditional request semantics (`If-Match`, `ETag`) — MSE's `snapshot`
>   field is compatible with being *implemented via* such mechanisms, but MSE
>   does not require or define them

§5 includes `SNAPSHOT_MISMATCH` in the standard `RefusalReason` vocabulary:

> - one of five standard reasons: `QUOTE_EXPIRED`, `SNAPSHOT_MISMATCH`,
>   `CONSTRAINT_VIOLATED`, `GUARANTEE_UNKNOWN_AT_COMMIT`, `PROVIDER_REJECTED`;

Schema, `schema/mse-core.schema.json` at tag `v0.3.0` — `snapshot` description (verbatim):

> "Opaque, provider-defined precondition material representing the state of `target` at quote time (e.g. a version, ETag, content hash, or provider-internal token). The core assigns this value no shape or meaning and does not require it to be a universally comparable/updatable token — it is whatever the provider needs to detect drift by whatever mechanism the provider actually implements. A profile/adapter declaring `commitConsistency` other than NONE MUST document, in its own adapter documentation, what `snapshot` contains and how drift is actually detected (see /spec/normative-spec.md §6); the core does not and cannot verify this from the schema alone. Optional: not every provider can offer a snapshot reference."

Schema — `commitConsistency` enum and description (verbatim):

> `"enum": ["SNAPSHOT_REQUIRED", "SNAPSHOT_ADVISORY", "NONE"]`
>
> "Declares how a provider will use `snapshot` at commit time. SNAPSHOT_REQUIRED: commit MUST be refused if the resource's current state does not match snapshot, by whatever provider-defined comparison the adapter documents. SNAPSHOT_ADVISORY: provider MAY warn or re-quote on drift but is not required to refuse. NONE: no snapshot-based drift detection is offered. The core does not require a universal/shared snapshot token scheme across providers, and does not require every mutation path into a resource to update the same tracked value — see /spec/normative-spec.md §6."

### (d) Guarantee contract — §4, §3.1, §3.2

§4, "Guarantee semantics" (verbatim table):

> | mode | meaning | caller may rely on value for AcceptanceConstraint evaluation? |
> |---|---|---|
> | `EXACT` | Provider guarantees this value will hold at commit, until `validUntil` (or indefinitely if absent) | Yes |
> | `REVALIDATE` | Provider believes this value is currently accurate but may need to re-check it at commit time | No — see §3.2 fail-closed rule |
> | `UNKNOWN` | No guarantee offered | No |

> An `EXACT` guarantee is a promise, not a description of the provider's
> confidence. A provider that is merely *fairly confident* but not actually
> willing to honor drift as a conformance violation MUST use `REVALIDATE`,
> not `EXACT`. This distinction is the entire point of the guarantee field;
> diluting it defeats the purpose of the schema.

§3.1, the EXACT marking rule:

> Each `Effect` in the quote MUST carry a `Guarantee` and a unique
> `effectId` (see §7a). A provider MUST NOT mark an effect `EXACT` unless it
> is actually prepared to honor that exact value at commit time, subject
> only to `expiresAt`/`guarantee.validUntil` and (if declared)
> `commitConsistency`. Marking an effect `EXACT` when the provider cannot
> actually guarantee it is a conformance violation, not an implementation
> detail — this is precisely the failure mode MSE exists to make visible
> and rejectable.

§3.2 fail-closed interaction with guarantees (AcceptanceConstraint evaluation):

> - if the matching effect's `guarantee.mode` is `UNKNOWN`, the constraint is
>   violated, because the value cannot be relied on;

§2 frames guarantee as the "Quote stability" uncertainty window:

> 1. **Quote stability** — did the predicted effects drift between the time
>    they were quoted and the time commit was attempted? (`Guarantee`,
>    `MutationQuote.expiresAt`, `MutationQuote.snapshot`)

## 4. Concurrent modification / authorization scope / protected state

### Concurrent modification

Normative spec, §3.2 (admission-to-dispatch gap):

> An `AdmissionRefusal` MUST correlate to the evaluated `quoteId` and the
> originating `proposalId`, carry an ISO 8601 `evaluatedAt`, and contain at
> least one failure. Its optional `stateRef` is opaque evidence of the state
> the binding evaluated; neither it nor `evaluatedAt` is a lock.

> The reference provider invokes a synchronous binding evaluator immediately
> before its in-process dispatch loop and performs no asynchronous yield
> between them. That demonstrates a check-before-dispatch boundary and an
> observable zero-dispatch refusal, not a distributed lock. An external-state
> binding MUST document whether it validates and dispatches atomically or
> revalidates within its own transaction. If state can change after the last
> check and dispatch may have occurred, a clean admission refusal is no
> longer available; normal per-unit determinacy and reconciliation apply.

Normative spec, §8 (Open issues — explicitly **non-normative until resolved**):

> 1. **Multiple outstanding quotes against the same target.** Carried over
>    from v0.1.0, still open. §6's resolution (snapshot is provider-defined,
>    adapters document their own drift detection) narrows this somewhat but
>    does not mandate a concurrent-quote policy.
> 2. **Whether `commitConsistency`/`snapshot` should be expressible per-unit
>    rather than only per-quote.** … v0.2.0 keeps `commitConsistency` at the
>    whole-quote level rather than guessing at a per-unit shape without
>    real-provider motivation for one.
> 6. **How external-state bindings close the admission-to-dispatch gap.**
>    The reference provider is synchronous and in-process; it does not prove
>    that a distributed provider can offer the same boundary without a
>    binding-specific transaction or final revalidation mechanism.

Same-tag non-normative doc, `docs/ambiguities.md` §5, "Concurrent quotes
against the same target — **OPEN**":

> "this only requires providers to *state* their concurrency answer, it does not supply one. Whether the core should additionally mandate a specific concurrent-quote policy (e.g. "issuing a new quote against a target invalidates prior outstanding quotes against the same target") is a genuine design question"

### Authorization scope

Normative spec, §1 — MSE does **not** define, and a conformant implementation
MUST NOT claim MSE alone provides:

> - identity, authentication, or delegation of authority to act as a principal
> - payment authorization or settlement

Normative spec, §3.2 — a witness is not permission:

> The amended proposal and quote remain independently subject
> to authorization, expiry, snapshots, acceptance constraints, idempotency,
> and a fresh admission evaluation. A witness conveys required information,
> not permission. Bindings MUST apply their existing authorization policy to
> every added transition and their existing idempotency rules to changed
> request content; MSE does not define either protocol.

Same-tag non-normative doc, `docs/security-considerations.md` §1,
"A quote is not an authorization":

> An `EXACT` guarantee on an `Effect` is a promise about *what will happen if
> committed*, not a statement that the caller is *authorized* to commit it. A
> provider MUST perform its own authorization check on every `CommitRequest`
> independent of anything in the quote. A client-supplied quote (or a quote
> replayed from another session) MUST NOT be treated as an authorization
> token.

And §1a of the same doc: "A `COMPLETE` witness can name additional transitions
needed to repair one relation. It does not prove that the caller may perform
them. A binding MUST authorize the amended proposal—including every added
transition—before issuing or committing its new quote."

### Protected state

**No "protected state" term exists in MSE v0.3.0.** Grep for `protected`
(case-insensitive) over `spec/`, `schema/`, and `src/` at tag `v0.3.0`
returns no matches. The nearest concepts in the actual text are:
existing commercial state as the mutation target (§1: "MSE defines the
**safety envelope** around an agent-initiated mutation of existing
commercial state"), the target resource's "durable commercial terms" in
§3.1 (quoted above), and `snapshot` as quote-time state precondition
material (§6 / schema, quoted above). Any SCQ-side "protected state"
concept has no direct MSE v0.3.0 counterpart under that name — do not
attribute one to MSE.

## 5. Conclusion for the SCQ comparison

MSE v0.3.0 **was located and verified** at the location above, so an
MSE-v0.3.0 comparison may be made against the excerpts in §3–§4 of this
file (and against the full files at tag `v0.3.0`), **not** against the
`f0339c2` / PR #6 draft material. Key v0.3.0 facts a comparison must not
overstate:

- Admission (`REQUIRES_COINCLUSION`) is a pre-dispatch gate only; it is
  explicitly **not** atomicity (§1d, §2).
- Snapshot/drift is provider-defined; the core mandates no universal token
  scheme and no rule that non-MSE write paths update the tracked value (§6).
- Concurrent-quote policy is an **open, non-normative** issue (§8.1);
  `stateRef`/`evaluatedAt` are "not a lock" (§3.2).
- Authorization is out of scope for MSE itself; bindings must apply their
  own policy (§1, §3.2).
- Guarantees are exactly three modes — `EXACT` / `REVALIDATE` / `UNKNOWN`
  (§4) — with fail-closed constraint evaluation (§3.2, §4a).
