# G-17 research — Chargebee non-replacement updates and the SCQ authorization boundary

Status: **Initial source-backed capability investigation; NO execution approval.** Workstream [#30](https://github.com/agorail-labs/subscription-change-quote/issues/30). Based on public Chargebee documentation consulted October 30, 2026 and SCQ `main` at `758e97e004b3135658e3f19e15f0837a38cf5756`. No live provider session, mutation, SDK execution, or independent vendor clarification was performed for this memo.

## 1. Finding: the current adapter's capability and the provider's API repertoire are different statements

**Confirmed in SCQ source:** `reference/src/live/chargebee-scq-adapter.ts` constructs a **plan-inclusive, complete quote-time item list** in `buildChargebeeUpdateParams` and sends `update_for_items` with `replace_items_list: true`. It advertises a module-private `ADAPTER_MUTATION_CAPABILITY = "FULL_REPLACEMENT_ONLY"`. PR #24's guard refuses OPERATION-scoped update commits before dispatch. This is appropriate for the adapter SCQ has actually implemented. The claim must not be silently broadened to *all* Chargebee operations.

**Confirmed in current public vendor docs:** Chargebee's **Update a subscription / update_for_items** endpoint documents `replace_items_list` as optional with default `false`. With `true`, a plan-inclusive request replaces the entire item list. With `false`, the supplied items are *added to the existing list*; a supplied plan can replace the current plan on sites without multi-plan subscriptions, or be retained alongside the existing plan where multi-plan is enabled. With an addons-only request and `false`, existing plan remains and supplied addons are added. This documents a **different wire mode**, not that it implements SCQ's existing-item quantity-change authorization contract atomically.

Vendor source: [Chargebee — Update a subscription](https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items). Related non-mutating quote endpoint: [Create a quote for subscription update](https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items).

**Not established:** A same-item quantity change in `replace_items_list=false` mode safely modifies only that existing item without duplication or undisclosed side effects; whether this remains true across plan/addon type, mandatory addons, site settings, and concurrent edits; whether a provider-enforced conditional-write/CAS precondition exists. `resource_version` appears in responses, but a read-side version field is **not** proof the write endpoint accepts an atomic expected-version condition. No provider endpoint was found in the reviewed documentation that establishes that precondition, which is not the same as proving no such endpoint exists.

## 2. Authorization-specific capability assessment (provisional)

| Operation / state | `replace_items_list=true` full target | `replace_items_list=false` documented mode | SCQ OPERATION authorization consequence |
| --- | --- | --- | --- |
| Add a **new addon** | May erase concurrent independently added addons when using a plan-inclusive target | Documented as adding supplied addon while retaining existing plan/addons | Candidate narrower operation; still must prove effect of duplicate IDs, mandatory items, schedules, invoice/proration and concurrent updates |
| Change **existing addon quantity** | Sets quote-time complete list; concurrent additions can be lost | Docs do not establish precise same-ID quantity-update behavior for this use case | **UNKNOWN:** require provider-specific source or authorized test evidence; do not infer targeted update |
| Change **plan** | Replaces whole plan/addon target | Behavior depends on multi-plan setting; existing plan may be replaced | Could mutate terms and mandatory addons; not presumed operation-preserving |
| Change **cadence** | Plan-inclusive replacement risks collateral changes | No precise targeted cadence semantics validated | **UNKNOWN:** keep refusal |
| Remove addon | Full replacement may remove unrelated concurrent items | Additive semantics do not themselves supply removal | **UNKNOWN / not shown**; keep refusal |
| Cancel subscription | Different operation class; do not extrapolate item-update behavior | Not evaluated here | Analyze and classify cancellation separately |

The documented `false` behavior narrows *one* risk (full-list erasure) for some addition cases; it does not by itself close quote-to-commit concurrency risk, preservation of scheduled changes, or independent financial authorization.

## 3. Documented external side effects to preserve in the threat model

The same vendor documentation warns that updating a subscription can delete or draft existing scheduled changes / ramps depending on site configuration, can trigger proration/credit notes, and that an invoice or collection may result under relevant billing settings. With `replace_items_list=true`, mandatory addons can be treated specially. **Therefore retaining the item list alone is not an adequate preservation proof** for a quote authorized to change only one item. Previews, user authorization and post-commit receipts must not claim protection for what this request cannot actually preserve.

## 4. Failing-first simulator cases required before any adapter capability change

Use mock transport only and never loosen the actual adapter's current dispatch guard while researching. Every case specifies T0 quoted state, T1 external change, T2 last pre-dispatch read, T3 proposed wire update, T4 observed result and receipt determination.

1. **Third-party addon arrives after T2:** T3 must not delete it; else OPERATION preservation is unenforceable.
2. **Existing quantity changed independently after quote:** if the proposed update would overwrite an unrelated edit, fail closed absent a provider-enforced condition or a demonstrably narrowed authorization.
3. **Same item-price ID with different quantity under `false`:** establish whether add, replace, merge, duplicate or rejection semantics apply. Do not invent a provider response in the test fixture as evidence of live behavior.
4. **Plan settings / mandatory addon / mult-plan mode:** vary plans, addons, site capabilities and mandatory attachment; assert correct preservation classifications.
5. **Scheduled change or ramp exists:** fail closed if the update can cancel, reset or draft a schedule outside the permitted authorization.
6. **Wrong site / subscription / currency / cadence:** ensure binding and unit checks still gate all modes.
7. **Lost response / late observation:** return INDETERMINATE without re-dispatch; later independently observed actuals must not override unrelated authorization preservation failure.
8. **Financial side effects:** proration, credits and invoices cannot be inferred from identical item counts; maintain UNKNOWN or refuse without establishing evidence.

Mark test cases **SIMULATED**, and keep any live or vendor-documented semantics independently labeled. The existing seven guard-blocked research cases remain guard-blocked and must not be presented as tests of downstream layers.

## 5. Decision tree / exit criteria for issue #30

- **A — TARGETED_UPDATE:** only if the vendor contract actually guarantees the target operation modifies no unauthorized related state for the specified site and action. Implement an adapter-specific, operation-scoped capability with new negative tests in its own reviewed PR; no automatic elevation from `FULL_REPLACEMENT_ONLY`.
- **B — CONDITIONAL_WRITE:** only if provider documentation and evidence establish atomic expected-version rejection at the mutating endpoint, with a verified read/write identity binding; a read-only `resource_version` field does not qualify.
- **C — FULL_REPLACEMENT_ONLY:** if neither A nor B meets requirements, preserve the existing OPERATION refusal. This is the current default.
- **D — TARGET_REPLACEMENT authorization:** separate normative decision under deferred G-14, explicit user consent to the complete replacement effect, and full financial/term safety analysis; not a fallback enabled by this research memo.

**Next evidence needed:** exact provider or SDK semantics for same-ID quantity update and scheduled-change interaction in `false` mode, and an independently reviewed offline counterexample matrix. After that, a separately authorized *read-only* site-specific preflight may verify tenant facts; no live mutation is authorized by any of this work.

## 6. Unchanged safety gates

Issue #12 remains **NO-GO**. Do not set `SCQ_LIVE_COMMIT_ENABLED`, call any mutating Chargebee endpoint, create a release, apply a protocol approval label, or bypass the G-17 guard. This memo is a documented hypothesis for research, **not** proof of a safe provider mechanism or a closed G-17.
