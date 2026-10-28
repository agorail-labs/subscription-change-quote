# Errata — SCQ v0.6.1 (Chargebee factual attributions)

**Errata package date: 2026-10-27** (America/Los_Angeles)
**Applies to:** `spec/scq-v0.6.1-spec.md` as published at commit
`79200fa4cbcf955c618428c0fca74fd2abce7c9d` (main) — the published spec
file is **unchanged** by this package (see "Freeze-guard status").
**Prepared in:** Phase 2B; submitted for review in Change A, branch
`review/change-a-evidence-spec-corrections` (Change A merged as PR #3).
**Status: PENDING APPLICATION — application prepared, not yet applied.**
The exact in-spec application of ER-1…ER-4 (including the §5
revision-history entry) is prepared on branch
`review/errata-application-v0.6.1` as a narrow PR, with a
machine-checkable zero-obligation-change proof
(`research/errata-application/NORMATIVE-DIFF-PROOF.md`). These errata
are **not yet applied** to the published `spec/scq-v0.6.1-spec.md` on
main: application takes effect only when that PR is labeled
`protocol-change-approved` (the process in §7) and merged, neither of
which has occurred. Until then the published spec file remains
unchanged.
**Supersedes as a proposal vehicle:** `research/chargebee-live-v1/ERRATA-PROPOSAL.md`
(Phase 2A). Items E-1, E-3, E-2, and E-5 of that proposal are resolved
here as errata ER-1…ER-4 with exact replacement wording. Item E-4
(capability status dimension) is **not** an erratum — it remains an
open design question for a future spec cycle and is carried in §6.

## Rules of this package

1. **Factual only.** Every correction below changes a provider-specific
   factual statement (what Chargebee's documented Product Catalog 2.0
   contract contains, or what this research actually verified). No
   correction changes: the EXACT / REVALIDATE normative definitions,
   any API type, any of the four supported change actions
   (CHANGE_QUANTITY | CHANGE_PLAN | CHANGE_CADENCE | CANCEL), or any
   normative MUST / MUST NOT. Verified mechanically: applying ER-1…ER-4
   to the spec produces **zero changed lines containing MUST or
   MUST NOT** (token counts and full MUST-line diff vs `79200fa`
   identical — see the Phase 2B decision package).
2. **Transparent, not silent.** Each entry quotes the original
   published wording verbatim (line-wrap normalized) and the exact
   replacement wording. The published spec's revision history (§8
   schema diff) is preserved untouched; this package is the dated
   revision record for these corrections until the labeled in-spec
   application in §7 occurs, at which point the same entries are added
   to the spec's revision history using the wording in §5.
3. **Language discipline.** Undocumented `effective_from` financial
   pinning is **NOT ESTABLISHED**. No entry asserts that no equivalent
   mechanism exists anywhere in Chargebee's products; each asserts only
   what the current documented contract for the named endpoint does and
   does not contain (Phase 1 audit, docs re-read 2026-10-27) plus the
   Phase 2A documentation audit.

---

## ER-1 — §4.1: Chargebee removed from the EXACT pinning-mechanism attribution (was E-1, HIGH)

**Classification: factual errata. Normative impact: none** — §4.1's
definition of EXACT ("for any dimension where `GuaranteeCoverage`
reports `"EXACT"`, the commit is guaranteed to reproduce EXACTLY the
value of THAT DIMENSION") is untouched; only the provider-mechanism
examples change.

**ER-1a — Original (§4.1, paragraph):**

> "No adapter's actual EXACT mechanism changed — Stripe's, Zuora's, and
> Chargebee's `proration_date`/`effectiveDate`/`effective_from` pinning
> already only ever computed the specific dimensions `GuaranteeCoverage`
> models; this correction brings the WORDING in line with what those
> mechanisms have always actually done."

**ER-1a — Corrected:**

> "No adapter's actual EXACT mechanism changed — Stripe's and Zuora's
> `proration_date`/`effectiveDate` pinning already only ever computed
> the specific dimensions `GuaranteeCoverage` models; this correction
> brings the WORDING in line with what those mechanisms have always
> actually done."

**ER-1b — Original (§4.1, mechanism bullet):**

> "Having order/estimate math that is inherently a pure function of an
> explicit, caller-supplied instant rather than ambient "now" (Zuora's
> `effectiveDate`, Chargebee's `effective_from`)."

**ER-1b — Corrected:**

> "Having order/estimate math that is inherently a pure function of an
> explicit, caller-supplied instant rather than ambient "now" (Zuora's
> `effectiveDate`)."

**Evidence:** `effective_from` is not a documented parameter of
`update_for_items` in current Chargebee Product Catalog 2.0
documentation; it is the required parameter of Create-a-ramp. No
estimate-pinning or replay mechanism is documented for the
estimate→update pair. After the Phase 2A correction, no Chargebee
adapter in this repository claims EXACT for any financial dimension or
for `effectiveAt` (both REVALIDATE), and `termEffect` is UNKNOWN at the
coarse capability level and for committed-term CANCEL quotes. The
single remaining quote-level EXACT anywhere in the Chargebee coverage
is evergreen CANCEL's `termEffect` (Test 11g) — and overall EXACT is
still refused for every Chargebee action, because an overall EXACT
request requires every dimension to be EXACT and the financial
dimensions are REVALIDATE. So the published mechanism list (which
attributed a financial-pinning mechanism to Chargebee) and the
reference implementation disagreed. One historical live case in which an estimate and a commit
agreed ($840, `research/EVIDENCE.md` item 1) is a single observation,
not a guarantee mechanism, and is not cited as one here.

## ER-2 — §9 U-5: "DATE verified-once" withdrawn (was E-3, HIGH)

**Classification: factual errata. Normative impact: none** — U-5 is an
unresolved-issues entry, not a rule; the `EffectiveIntent` schema it
discusses is unchanged.

**Original (§9, U-5):**

> "**U-5 — Chargebee's `effective_from` vs `end_of_term` distinction is
> modeled** (via `EffectiveIntent.DATE` vs `.TERM_END`), closing the
> v0.5-LIVE gap — but only ONE of the two mechanisms (`end_of_term`)
> was independently re-verified against a fresh, isolated raw
> request/response pair during v0.5-LIVE; `effective_from` was verified
> via the original Experiment 2 pass only. Treat `DATE` support on
> Chargebee as verified-once, not extensively-verified. **Unchanged by
> v0.6.1.**"

**Corrected:**

> "**U-5 — Chargebee scheduling mechanisms.** `EffectiveIntent` models
> `TERM_END` and `DATE` as distinct intents; the schema distinction is
> unchanged. `end_of_term` was independently re-verified against a
> fresh, isolated raw request/response pair during v0.5-LIVE and is
> now deprecated-but-documented in current Chargebee Product Catalog
> 2.0 documentation (deprecated in favor of Ramps, Early Access). DATE
> via `update_for_items` is NOT ESTABLISHED in the current documented
> contract: `effective_from` is not a documented parameter of that
> endpoint, and the earlier characterization of DATE support as
> verified-once is withdrawn. Both reference Chargebee adapters refuse
> DATE."

**Evidence:** same documentation audit as ER-1. The historical
Experiment 2 record is **not** deleted: it remains in
`research/research-findings.md` with the Phase 2A addendum that
supersedes its verification grade. What is withdrawn is the *spec-level
verification grade* ("verified-once") for a parameter the current
documented contract does not list for that endpoint — not the
historical observation itself.

## ER-3 — §3.1: effective-intent rationale annotated as historical (was E-2, MEDIUM)

**Classification: factual errata. Normative impact: none** — §3.1's
rules (exactly one `EffectiveIntent` per proposal; refusal rather than
silent substitution) are untouched; only the rationale sentence's
provider examples change.

**Original (§3.1, rationale):**

> "three semantically and mechanically different requests that, on
> Zuora and Chargebee, invoke different native code paths
> (`effectiveDate` vs `end_of_term=true` boolean vs `effective_from`
> timestamp on Chargebee specifically)."

**Corrected:**

> "three semantically and mechanically different requests that, on
> Zuora and Chargebee, invoke different native code paths
> (`effectiveDate` on Zuora; historically an `end_of_term=true` boolean
> on Chargebee)."

**Evidence:** both Chargebee mechanisms named in the original are, in
current documentation, deprecated (update-endpoint scheduling, toward
Ramps) or not parameters of that endpoint at all (`effective_from`).
The rationale is historically accurate for why the schema was designed;
the corrected wording marks it as historical so it is not cited as a
statement about the current API. The schema distinction remains valid
— providers differ in whether and how they honor each intent, which is
exactly what `supportedEffectiveIntents` plus refusal (§6.7) is for.

## ER-4 — §6.10: conformance note on durability (was E-5, MEDIUM)

**Classification: factual/documentation errata (an added conformance
note). Normative impact: none** — §6.10's rule is **not weakened and
not reworded**: a repeated `commitChangeQuote` against an
already-committed `quoteId` MUST NOT apply the change a second time and
MUST return the original receipt, checked before any provider read.
ER-4 adds documentation of what the rule presumes; it deliberately
contains no new MUST/MUST NOT (the words "requires"/"does NOT
establish" below are descriptive, and the zero-MUST-diff proof covers
this entry).

**Original:** §6.10 has no durability or recovery text (absence is the
defect: read together, the rule and the in-memory reference
implementation overclaim).

**Added text (appended to §6.10 as a conformance note):**

> "**Conformance note on 6.10 (errata, documentation only — the rule
> above is unchanged):** the idempotency rule presumes the
> implementation can retrieve the original receipt on a repeated
> commit, including after a process restart and after an indeterminate
> commit outcome (the mutation may have succeeded while its response
> was lost). A conforming live deployment therefore requires durable
> persistence of the quote, its request identity, its outcome, and its
> receipt, plus a safe recovery procedure that reconciles provider
> state after an indeterminate outcome before any further mutation is
> attempted. The reference implementation's in-memory `QuoteStore`
> does NOT establish this guarantee across crashes: after a restart it
> can only fail closed, which is safe but is not conformance with the
> replay requirement. Provider-native idempotency is not a substitute
> and is not indefinite: Chargebee's documented native idempotency
> window is 30 minutes."

**Evidence:** `reference/src/store/quote-store.ts` is a volatile
in-process `Map` (its header states this limit explicitly since
Phase 2A); test13 T13 (in the unpublished Change B — not a test in
this change) demonstrates fail-closed-after-restart behavior in the
live-shaped adapter, not replay. Chargebee's documented native
idempotency (`chargebee-idempotency-key`) replays for 30 minutes,
returns 422 on same-key/different-parameters, 409 while in flight, and
caches 5xx responses under the key — useful within its window, never
a basis for an indefinite idempotency claim.

---

## 5. Revision-history supplement (exact entry for the labeled in-spec application)

When ER-1…ER-4 are applied to `spec/scq-v0.6.1-spec.md` through the
process in §7, the following entry is added to the spec's revision
record (§8 area) verbatim, and §8's existing tables are **not**
otherwise altered:

> "**Errata 2026-10-27 (factual corrections only — no normative
> change):** §4.1 no longer attributes an `effective_from` pinning
> mechanism to Chargebee (ER-1); §9 U-5 no longer characterizes
> Chargebee DATE support as verified-once — DATE via `update_for_items`
> is NOT ESTABLISHED in the current documented contract and `end_of_term`
> is deprecated-but-documented (ER-2); §3.1's rationale examples are
> marked historical (ER-3); §6.10 gains a conformance note documenting
> the durable-persistence presumption of the idempotency rule (ER-4).
> Full before/after wording: `spec/ERRATA-v0.6.1.md`. No MUST/MUST NOT,
> type, definition, or supported action changed."

The original v0.6.1 release text and its §8 history remain part of the
record: the errata entries above quote the superseded wording rather
than erasing it, and the Phase 1/2A git history (commits `5dbb9c7`,
`7e993a3`) preserves the pre-correction adapter claims.

## 6. Chargebee scheduling taxonomy (normative for how capabilities are advertised)

Every Chargebee scheduling capability advertised anywhere in this
repository — adapter capability reporting, documentation, conformance —
carries exactly one of these four classifications:

| Capability | Classification | Basis |
|---|---|---|
| IMMEDIATE via `update_for_items` / `cancel_for_items` — simulator-backed adapter | **Supported and tested** | Test 11 suite (simulator); advertised in `supportedEffectiveIntents` |
| IMMEDIATE via the experimental live adapter (unpublished Change B — not part of this change) | **Supported and tested** (within Change B) | Mocked-transport tests (test13 T01–T03) in the unpublished Change B; live execution BLOCKED (no credentials) — the label covers the tested mocked behavior, not a live claim |
| TERM_END for CANCEL via `cancel_for_items` `end_of_term=true` — simulator-backed adapter only | **Documented but deprecated** | Documented on that endpoint; deprecated-adjacent in current docs; historically observed in the limited v0.5-LIVE research; retained under this label, financial coverage REVALIDATE |
| TERM_END for update-backed actions (CHANGE_QUANTITY / CHANGE_PLAN / CHANGE_CADENCE) via `update_for_items` | **Unsupported by the current adapter** | Mechanism is documented but deprecated; the simulator never modeled `end_of_term` as the distinct boolean the endpoint takes; refused with `UNSUPPORTED_CHANGE` |
| DATE via `update_for_items` (`change_option=specific_date` / `changes_scheduled_at`) | **Unsupported by the current adapter** | Documented-but-deprecated scheduling paths; refused by both adapters; DATE via `effective_from`-on-update is NOT ESTABLISHED (ER-2) |
| DATE / TERM_END via Ramps (`create_ramp`, `effective_from`) | **Site-feature-dependent or early-access** | Ramps is Early Access and site-gated; **not implemented** in any adapter in this phase (Phase 2B adds no Ramps support) |
| CANCEL against a committed-term subscription (Contract Terms) | **Site-feature-dependent or early-access** | Contract Terms is a site feature that was not enabled on any test site available to this research; semantics UNVERIFIED; quote-level `termEffect: UNKNOWN` |

Rules that follow from the table: an adapter MUST NOT advertise an
intent classified "Unsupported by the current adapter" or
"Site-feature-dependent or early-access" in `supportedEffectiveIntents`
(the sentence restates §6.5/§6.7 for this taxonomy; it adds no new
rule), and documentation must not describe a deprecated mechanism
without its classification label.

## 7. Freeze-guard status and the proposed exception process

The protocol freeze guard (`.github/workflows/protocol-freeze-guard.yml`)
checks any PR against main for changes to `spec/scq-v0.6.1-spec.md`,
`reference/src/core/types.ts`, or `reference/src/core/scq-engine.ts`,
and fails the PR unless it carries the `protocol-change-approved`
label. This package does **not** change any of those three files, so
the errata package itself passes the guard (verified locally, Phase 2B
decision package).

Applying ER-1…ER-4 **in-spec** was tested locally on a disposable
probe branch (commit `01fc584`, branch deleted after capture; not part
of any review branch). The guard's logic, run locally against that diff
with the label check stubbed to "no label", fails with exactly:

```
This PR modifies frozen protocol surface:
spec/scq-v0.6.1-spec.md

BLOCKED: this PR changes normative spec/core-engine surface but is not
labeled 'protocol-change-approved'. Per CONTRIBUTING.md, protocol changes
are made deliberately in response to a specific, discussed issue — link
that issue in the PR description, then have a maintainer apply the
'protocol-change-approved' label to unblock this check.
```

(exit code 1; output reproduced from the workflow's own script text.)

The guard was **not** disabled, edited, or bypassed. Proposed narrow,
auditable exception process — the guard already contains the mechanism;
this package proposes constraining its use for factual errata:

1. In-spec errata are applied only in a PR whose **sole** frozen-surface
   change is `spec/scq-v0.6.1-spec.md` and whose spec diff matches
   `spec/ERRATA-v0.6.1.md` entries verbatim (machine-checkable:
   before/after wording quoted in the errata package).
2. The PR description links the errata package and attaches the
   zero-MUST/MUST NOT-diff proof (token counts + MUST-line diff vs the
   base must both be empty).
3. A maintainer applies `protocol-change-approved` — the label
   application, the errata package, and the MUST-diff proof together
   form the audit trail. No workflow change is needed or proposed.
4. Alternative if maintainers prefer zero frozen-file contact in an
   errata PR: publish this errata package alone (it changes no frozen
   file) and defer in-spec application to the next versioned release
   (v0.6.2), where the §5 supplement entry is folded into that
   version's revision history.

Either path keeps every correction traceable to a dated errata entry;
neither rewrites the published v0.6.1 evidence silently.
