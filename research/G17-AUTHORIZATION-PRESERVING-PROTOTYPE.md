# G-17 — Authorization-preserving provider mechanism: verification, adversarial prototype, and recommendation

Status: **Independent review package. G-17 remains OPEN. The live adapter is unchanged and its OPERATION refusal remains in force.** Workstream [#30](https://github.com/agorail-labs/subscription-change-quote/issues/30); related [#12](https://github.com/agorail-labs/subscription-change-quote/issues/12) (pilot readiness — still NO-GO). Builds on the merged research memo in `research/G17-CHARGEBEE-NONREPLACEMENT-RESEARCH.md` (PR #32, `53fd16d`). Based on Chargebee's public API documentation consulted **2026-10-31** and SCQ `main` at `9bb424b`. **No live provider session, no credentials, no mutating request, and no read-only provider interaction were performed for this package.** Everything executable here is mock-transport only.

**Correction round (this revision):** an independent review of this PR @ `ecc3ff5` raised four findings — **G17-R1** (ADD_ADDON is not an SCQ action), **G17-R2** (`resource_version` is a timestamp, not a change counter), **G17-R3** (scheduled-change races are invisible to a flag comparison), **G17-R4** (the preservation verdict's scope is the visible item subset only). All four are **accepted and corrected** in the code, the mock, the tests, and this document; §10 records each finding, the correction, and which earlier statements are withdrawn or narrowed. The disposition is unchanged: recommendation **C**, G-17 OPEN, Issue #12 NO-GO.

Deliverables in this PR:

| Artifact | Content |
| --- | --- |
| `reference/src/live/pilot/g17-mock-transport.ts` | Stateful mocked Chargebee transport. Rules are labeled **DOCUMENTED (D1–D6)** or **ASSUMED (A1–A2)** in the file header; the one genuinely unknown behavior (same-ID additive semantics) is a parameter, not a hidden assumption. |
| `reference/src/live/pilot/g17-targeted-update.ts` | Isolated prototype executor: minimal additive dispatch + T0/T2/T3/T4 preservation verification. **Not exported from `src/index.ts`, not wired into the live adapter.** |
| `reference/tests/test53-g17-targeted-update.test.ts` | 36 tests: positive paths, wire-shape pins, assumed-semantics dependence, unsupported-class refusals, the full adversarial concurrency matrix, a control reproducing the Issue #22 Finding 1 deletion under the current full-replacement wire shape on the same mock, and the G17-R1..R4 correction tests (53.31–53.36). |
| This file | Phase 1 verification, capability matrix, Phase 3 decision matrix, proposed architecture, vendor clarification request, A/B/C/D recommendation, read-only pilot conditions, and the §10 correction record. |

Suite result at delivery: **757/757** on Node 20 and Node 22 (721 baseline at `9bb424b` + 36 in test53), demo and `smoke:pack` green. Zero pre-existing files modified; `git diff` against the live adapter is empty.

---

## 1. What was asked, and the one-sentence answer

Find a technically defensible way to execute an operation-scoped subscription change without altering unrelated subscription state — or prove rigorously that the current provider cannot supply one.

**Answer:** Chargebee documents a genuinely *additive* dispatch (`replace_items_list=false`, minimal payload) that structurally cannot delete concurrently added items, and this package demonstrates it working — in simulation — for **ADD_ADDON** (documented) and for **CHANGE_QUANTITY** (only under an *assumed* reading of the docs). But the provider documents **no atomic conditional write**, the docs **delete or draft existing scheduled changes on any update**, and the same-ID quantity semantics on which CHANGE_QUANTITY depends are **nowhere guaranteed**. Two scope corrections from independent review (§10) further narrow what this proves: **ADD_ADDON is a provider operation class, not an SCQ action** — the SCQ schema (`ChangeAction`) has no such action, so its positive result demonstrates provider capability only, not a path any SCQ proposal can currently take; and the prototype's post-hoc verdict certifies **only a visible item subset**, with interleaving never excluded. The defensible conclusion is therefore: **the candidate mechanism is real but partial, and for the actions SCQ actually has it is not yet a mechanism at all; it does not meet the bar for relaxing G-17.** Recommendation **C stands for the live adapter**. CHANGE_QUANTITY — the only in-schema action with even wording-level support — remains blocked on the vendor clarification request in §8 and on the evidence limits in §10.

---

## 2. Phase 1 — Provider capability verification

Evidence classes used throughout, per the task: **DOCUMENTED** (guaranteed by provider documentation, quoted below), **SIMULATED** (demonstrated by an executable mock in this PR), **LIVE-READ** (verified through a real read-only provider interaction — **none in this package**), **UNKNOWN** (not established).

### 2.1 Primary vendor references

1. **Update a subscription (`update_for_items`)** — https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items — the endpoint reference: `replace_items_list` semantics, input-parameter list (exhaustively reviewed 2026-10-31), and the *Impacts* section on scheduled changes / ramps / mandatory addons.
2. **How to remove addons from a subscription via API in Latest Product Catalog** (Chargebee KB) — https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20 — removal requires `replace_items_list=true` with the retained set.
3. **Idempotent requests** — https://apidocs.chargebee.com/docs/api/idempotency — 30-minute window, replay header, 409 in-flight conflict, 422 same-key/different-parameters, 5xx responses cached under the key; estimates do not support idempotency.
4. **Cancel a subscription (`cancel_for_items`)** — https://apidocs.chargebee.com/docs/api/subscriptions/cancel-subscription-for-items — a separate endpoint family; deletes ramps effective on/after the cancellation time; contract-term branches.
5. **Create a subscription ramp** — https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp — `items_to_add` / `items_to_update` / `items_to_remove` structure; future `effective_from`; ramp limits.
6. **Remove scheduled changes** — https://apidocs.chargebee.com/docs/api/subscriptions/remove-scheduled-changes — scheduled changes are a distinct, separately managed state; exactly one scheduled change may exist for this endpoint (multiple ramps error).
7. **Subscriptions (object + docs index)** — https://apidocs.chargebee.com/docs/api/subscriptions — `resource_version`: *"updated with a new timestamp in milliseconds for every change made to the resource"*; list APIs are eventually consistent and the retrieve endpoint is the read-your-writes path (List operations / Read consistency).
8. **Estimate for updating a subscription** — https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription — the non-mutating estimate twin of `update_for_items`, accepting the same `replace_items_list` parameter.
9. PR #32's memo (`research/G17-CHARGEBEE-NONREPLACEMENT-RESEARCH.md`) — the prior source-backed investigation this package extends; nothing in it is contradicted here, and its open questions are the ones §2.2–§2.5 resolve or sharpen.

### 2.2 `replace_items_list=false`: exact documented semantics

From reference 1 (parameter text, verified 2026-10-31):

> `replace_items_list` — optional, boolean, default=false. Determines whether the provided `subscription_items` replace existing subscription items or are added to the existing list.
> **When `subscription_items` includes a plan** — `true`: The entire subscription item list (plan and addons) is replaced by the provided list. `false`: The provided items are added to the existing list. If multi-plan subscriptions is disabled, the existing plan item price is replaced. If multi-plan subscriptions is enabled, the existing plan item price is retained.
> **When `subscription_items` contains only addons** — The existing plan on the subscription is always retained; it is not replaced. `true`: Existing addons are replaced by the provided addons, except mandatory addons (auto-attached to the plan). Mandatory addons are kept unless you list them in `mandatory_items_to_remove`. `false`: The provided addons are added to the existing addons.

The endpoint's opening line adds a general statement: *"Updates a subscription by modifying its item prices, coupons, billing configuration, payment method, and other attributes. Any parameters not provided remain unchanged."*

And the `subscription_items` parameter itself is described as *"The list of item prices to **add or update** in the subscription,"* with `item_price_id` as *"The unique identifier of the item price to **add or update** in the subscription"* and `quantity` as *"The quantity of the item price purchased."* The endpoint's own sample request passes a single item with a quantity and **no** `replace_items_list` (i.e. additive mode).

**What this establishes (DOCUMENTED):**
- An addons-only additive payload retains the plan and adds the supplied addons; nothing in the documented additive semantics removes an existing item. Deletion of a concurrent addition — the Issue #22 Finding 1 failure — is a property of the `true` mode, not of this endpoint per se.
- A plan-carrying additive payload is **site-configuration-dependent** (multi-plan on/off produce materially different results — demonstrated at mock level in test 53.29). It is not one mechanism; it is two.
- Removal is **not** an additive operation: reference 2 directs removal through `replace_items_list=true` + the retained set, i.e. through the very full-replacement dispatch G-17 blocks.

**What this does not establish (UNKNOWN):**
- **Same-ID quantity semantics.** "Add or update" is the strongest available wording, and it supports an update-in-place *reading*. It never states whether a supplied item whose `item_price_id` already exists (a) updates that entry's quantity to the supplied absolute value, (b) appends a duplicate entry, (c) sums quantities, or (d) is rejected. Each behavior is compatible with the published text; they have opposite preservation and financial consequences. This is the single most important unknown in the package (vendor question Q1, §8).
- Whether additive mode preserves a concurrent change to the *same* item (it cannot, under any absolute-set reading — see §4, scenario 2b).
- Behavior when the same ID is supplied with a `unit_price` override, tiered/volume pricing models, decimal quantities, or `billing_cycles` — none addressed for the additive same-ID case.

### 2.3 Per-operation findings

| Operation | Finding | Class |
| --- | --- | --- |
| **Add a new addon** | Additive mode documents exactly this: supplied addons are added, plan and existing addons retained. Preconditions: the item price's currency must match the subscription's (stated on `item_price_id`); quantity is only meaningful for `per_unit`/`stairstep`/`tiered` pricing models; a per-unit addon cannot reduce quantity and change `unit_price` in one call. Concurrency: a concurrent addition survives structurally; a concurrent change to anything else is not protected by the request, only detectable at T4. | DOCUMENTED |
| **Change an existing item's quantity** | Depends entirely on the UNKNOWN same-ID semantics (§2.2). Wording ("add or update", sample request) supports the update-in-place reading without guaranteeing it. Additional documented constraint: for `per_unit` addons, quantity *reduction* + `unit_price` change in one request is rejected at apply time for scheduled changes; quantity for `flat_fee` items is not a valid parameter at all (the live adapter already refuses that class pre-dispatch from Phase-3 live evidence). | UNKNOWN (wording-supported) |
| **Remove an existing addon** | No additive removal exists. Documented removal = `replace_items_list=true` + retained set (reference 2), or `mandatory_items_to_remove` for mandatory addons only. A "targeted removal" on this endpoint is a contradiction in terms today. Ramps offer `items_to_remove`, but only for future-scheduled changes (§2.6). | DOCUMENTED (as unavailable) |
| **Change plan** | Additive mode: multi-plan disabled → existing plan price replaced; enabled → existing plan **retained alongside** the new one (53.29 demonstrates both at mock level). Separately, a site setting (*Remove mandatory add-ons from old plan during subscription plan update*) can auto-remove the old plan's mandatory addons during a plan update; mandatory addons of the *new* plan auto-attach. Term behavior: a different billing period always resets the term; same period resets only with `force_term_reset`. None of this is operation-preserving by construction; the result depends on site configuration the quote cannot see from the subscription resource alone. | DOCUMENTED (site-dependent) |
| **Change cadence** | Cadence is not a parameter; it is a property of the plan item price's period. A cadence change is a plan change to a different-period price, with mandatory term reset. Inherits the CHANGE_PLAN row in full. | DOCUMENTED (as plan change) |
| **Cancel a subscription** | A different endpoint (`cancel_for_items`), never dispatched by the current adapter and refused at quote creation there. Documented side effects beyond the item list: ramps effective on/after the cancellation date-time are **deleted**; contract-term subscriptions must use `contract_term_cancel_option` instead of `cancel_option`; credits/unbilled-charges handling is governed by separate options. Cancellation is a whole-subscription operation, so "preservation of unrelated state" mostly dissolves — the preservation questions that remain (scheduled ramps, contract terms, credit handling) are real but belong to a separate assessment. This prototype keeps CANCEL **unsupported**. | DOCUMENTED (separate class) |

### 2.4 Scheduled changes, mandatory addons, billing side effects — the preservation dimensions beyond the item list

Reference 1's *Impacts* section (verified 2026-10-31) states, for **any** `update_for_items` call:

- **Ramps disabled:** *"Any existing scheduled change on the subscription is deleted."*
- **Ramps enabled (compatibility mode):** a single ramp created via this API is deleted; a ramp created via the Create-ramp API is moved to `draft` if the new change predates it and auto-draft conditions are met; with multiple ramps, all ramps after the new change's date-time are moved to `draft` under the same conditions.
- **Mandatory addons:** with the site setting enabled, all mandatory addons of the old plan are automatically removed during a plan update.
- **Financial:** if an invoice is generated, available credits and excess payments are automatically applied (subject to site limits / `billing_override`); mid-term changes with `prorate=true` may create prorated credit notes; `invoice_immediately` decides whether immediate charges are invoiced or left as unbilled charges.

Consequence: **item-list preservation is not preservation.** An additive dispatch that leaves every item untouched can still delete a scheduled change — state the customer authorized separately and the SCQ quote never mentioned. This is why the prototype refuses pre-dispatch whenever `has_scheduled_changes=true` (test 53.17), and why scenario 5b (53.24) matters: a schedule created *inside* the race window is destroyed by the dispatch, and the prototype's verdict correctly refuses to call that run verified. Any future adapter design must treat scheduled-change state as a first-class preservation dimension, not a warning flag.

### 2.5 Atomic conditional write: negative finding, stated precisely

The task requires this to be established, not inferred:

- The complete documented input-parameter list for `update_for_items` (reference 1, reviewed in full 2026-10-31) contains **no** expected-version, expected-state, `If-Match`, or precondition parameter of any kind. `resource_version` appears in the endpoint's documentation **only inside response examples**.
- The subscription object documentation (reference 7) defines `resource_version` as a millisecond timestamp updated on every change — a *detection and ordering* aid (the Events documentation uses it to order out-of-order webhooks), never a write input.
- No other subscription-mutating endpoint reviewed (cancel, ramps, remove-scheduled-changes) documents a version precondition either.

**Conclusion (DOCUMENTED as absent from the published contract):** Chargebee exposes no documented atomic compare-and-swap on subscription writes. This is a statement about the published API contract, not a metaphysical claim about the provider's internals — vendor question Q3 (§8) asks Chargebee to confirm or correct it. A pre-dispatch read (`resource_version` or otherwise) does **not** close the T2→T3 window; §4 scenario 2b is the executable demonstration. Approach **B is unavailable** on current evidence.

**What `resource_version` is and is not (G17-R2).** It is a millisecond timestamp of the most recent change. It is **not** a change counter (several changes inside one millisecond share a version; one change a day later produces a delta of ~86,400,000), **not** a causal token (it binds no write to the state its author read), and **not** attribution evidence. The first version of this package's mock advanced it by a fixed +1000 per change and the executor classified partly on that step; the review correctly identified that inference as a mock artifact with no production transfer, and it has been **removed** — the mock now stamps versions from a controllable clock with same-millisecond collisions, the executor records the version only as changed/unchanged colour, and CHANGE_QUANTITY's verdict ceiling is PRESERVATION_UNVERIFIABLE precisely because timestamp evidence cannot exclude an overwritten same-item interleaving (tests 53.2, 53.20, 53.32, 53.33).

What *does* exist is native idempotency (reference 3): replay of the same key+parameters inside 30 minutes, 422 on key reuse with different parameters, 409 while the original is in flight, 5xx responses cached under the key. Idempotency makes a *retry of the same request* safe; it says nothing about interleaved third-party change, and its 30-minute window is not a durable exactly-once guarantee (the existing durable coordinator remains necessary in any future design).

### 2.6 Ramps: genuinely targeted structure, wrong operation class

The ramp resource is the one place Chargebee's API is natively delta-shaped: `items_to_add`, `items_to_update`, `items_to_remove` are separate, explicit collections (reference 5). Three disqualifiers for the present objective:

1. **Future-scheduled only.** A ramp applies at its `effective_from`; it is not an immediate-execution mechanism, and SCQ's live adapter supports IMMEDIATE only, with Ramps already recorded there as site-gated and unimplemented.
2. **No execution-time preservation guarantee is documented.** What state a ramp's delta applies *onto* at execution time — after arbitrary intervening changes — is not specified as a preservation contract.
3. **Ramps are themselves fragile state:** an intervening `update_for_items` can delete or draft them (§2.4), and creating a ramp is blocked while any ramp is in draft.

Ramps remain a legitimate *separate* future assessment for TERM_END / DATE operation classes. They do not answer G-17 for immediate changes.

---

## 3. Provider capability matrix (by operation)

Legend: **D** = DOCUMENTED guarantee · **S** = SIMULATED demonstration in this PR · **U** = UNKNOWN / unsupported · **—** = not applicable. No cell in this matrix is LIVE-READ; no read-only provider interaction was performed.

| Operation | Additive wire exists | Semantics established | Concurrency behavior | Scheduled-change safety | Financial determinacy | Prototype posture |
| --- | --- | --- | --- | --- | --- | --- |
| Add new addon | D | D (add + retain) | S: concurrent additions survive in the item subset; same-window unrelated loss is detected, not prevented; invisible histories (add-then-remove, schedule created-then-deleted) are NOT excluded | D: update deletes/drafts schedules → prototype refuses when schedules exist at T2; a schedule created inside the window is destroyed invisibly (53.24) | Estimate twin accepts identical params (D); proration itself is time/site-dependent (U for exact figures) | **Provider capability only (G17-R1)** — documented targeted semantics, but **not an SCQ action**: no SCQ proposal can currently express it |
| Change existing quantity | D (payload shape) | U — "add or update" wording only; set/duplicate/sum/reject all compatible with the text | S under ASSUMED set semantics: a same-item race is overwritten and **nothing at T4 betrays it** — the raced and clean runs are observationally identical, capping the verdict at UNVERIFIABLE (53.2/53.20, G17-R2) | Same as above | U — depends on which same-ID behavior is real | **Blocked** on vendor Q1/Q2 + an operation-bound proof mechanism (Q3) |
| Remove addon | D (only via replacement) | D: removal requires `replace_items_list=true` + retained set | Replacement reintroduces the Finding 1 race in full | Same as above | — | **Refused** (unsupported) |
| Change plan | D | D but site-dependent (multi-plan; mandatory-addon site setting; term reset rules) | U | Plan updates additionally interact with mandatory addons of both plans (D) | U | **Refused** (unsupported) |
| Change cadence | — (is a plan change) | D as plan change; term always resets on period change | U | Same | U | **Refused** (unsupported) |
| Cancel | D (separate endpoint) | D as its own class, incl. ramp deletion + contract-term branches | — (whole-subscription op) | D: deletes ramps effective ≥ cancellation time | Credit/unbilled handling is option-driven (D), amounts U | **Refused here** (separate assessment required) |
| Conditional write (any op) | — | **D as absent**: no documented precondition parameter anywhere in the write surface | — | — | — | **Unavailable (approach B rejected on evidence)** |

---

## 4. Phase 2 — Adversarial concurrency results (test53, SIMULATED)

Protocol per run: **T0** quote-time snapshot → **T1** external change → **T2** pre-dispatch re-read → **T3** candidate dispatch → **T4** independent re-read (retrieve; Chargebee's own docs warn list reads are eventually consistent). A candidate **fails preservation** if it silently changes state outside the authorized operation. The mock's scheduled-change and idempotency behaviors are DOCUMENTED (D4/D5); its same-ID behavior is the labeled parameter A1.

| # | Scenario (task numbering) | Interleaving | Result | Test |
| --- | --- | --- | --- | --- |
| 1a | External addon added after quote | T1 before T2 | **REFUSED_PRE_DISPATCH_DRIFT**, 0 dispatches — the quote's financial basis changed even though the item itself would have survived | 53.13 |
| 1b | External addon added in the race window | T1 between T2–T3 | **ITEM_PRESERVED_WITH_CONCURRENT_CHANGE** — concurrent addon intact at T4; authorized change landed. The structural item-list win over full replacement (scope: item subset only) | 53.18 |
| 1c | Control: same interleaving, current production wire shape | T1 before a `replace_items_list=true` dispatch | Concurrent addon **deleted** — Issue #22 Finding 1 reproduced on this mock, proving the harness detects the failure | 53.19 |
| 2a | Same item's quantity modified after quote | T1 before T2 | **REFUSED_PRE_DISPATCH_DRIFT**, 0 dispatches | 53.14 |
| 2b | Same item's quantity modified in the race window | T1 between T2–T3 | **PRESERVATION_UNVERIFIABLE** — T4 matches the target exactly, and is *identical* to the clean run's T4 (53.2): under timestamp-only evidence the overwritten interleaving is indistinguishable from no interleaving, so the class ceiling applies (G17-R2) | 53.20 |
| 3a | Item removed after quote | T1 before T2 | **REFUSED_PRE_DISPATCH_DRIFT**, 0 dispatches | 53.15 |
| 3b | Item removed/replaced in the race window | T1 between T2–T3 | **PRESERVATION_VIOLATED** — a missing unrelated item at T4 cannot be attributed away, so the verdict fails closed | 53.21 |
| 4a | Mandatory addon attached in the race window | T1 between T2–T3 | **ITEM_PRESERVED_WITH_CONCURRENT_CHANGE** — mandatory addon intact in the item subset (its plan *association* is an unobservable dimension, §10/R4) | 53.22 |
| 4b | Mandatory addon disappears by T4 | T1 between T2–T3 | **PRESERVATION_VIOLATED** | 53.23 |
| 5a | Scheduled change exists | present at T2 | **REFUSED_SCHEDULED_CHANGE_AT_RISK**, 0 dispatches, schedule untouched — dispatching would have deleted it (D4) | 53.17 |
| 5b | Scheduled change created in the race window, then deleted by the dispatch — NEGATIVE test (G17-R3) | T1 between T2–T3, all at one timestamp | Mock state proves the dispatch **deleted** the concurrent schedule (D4), **and** T4 is identical to the no-schedule baseline: the destruction is invisible to any flag/version comparison. Verdict is **ITEM_PRESERVED_OBSERVED** for the item subset and itself declares schedule history unverifiable | 53.24 |
| 6a | Currency + plan (cadence) change after quote | T1 before T2 | **REFUSED_PRE_DISPATCH_DRIFT** (currency named in details), 0 dispatches | 53.16 |
| 6b | Plan/cadence change in the race window | T1 between T2–T3 | **PRESERVATION_VIOLATED** (plan changed) | 53.25 |
| 7 | Provider partially applies the request | fault: target lands, unrelated item dropped | **PRESERVATION_VIOLATED** | 53.26 |
| 8 | Mutation response lost after execution | fault: applied, then transport throws | **INDETERMINATE**, exactly 1 dispatch, no retry — and the verdict stays INDETERMINATE even though the mock state shows the change landed (observational equivalence with another actor's identical change; the PR #16 L1 lesson) | 53.27 |
| — | Success response that silently does not apply the target | fault | **TARGET_NOT_ESTABLISHED** | 53.28 |
| — | Same-ID semantics dependence (the Q1 unknown) | A1 parameter varied, identical wire request | update-in-place → target observed in effect but verdict capped at PRESERVATION_UNVERIFIABLE (53.2, G17-R2 ceiling); duplicate-entry → VIOLATED (53.5); quantity-summed → VIOLATED (53.6); reject → DISPATCH_REJECTED (53.7) | 53.2/5/6/7 |
| — | R1 schema pin | source read of core/types.ts | `ChangeAction` is exactly the four in-schema actions; ADD_ADDON absent; verdicts carry `inScqActionSchema` (false for ADD_ADDON, true for CHANGE_QUANTITY) | 53.31 |
| — | R2 delta-magnitude irrelevance | same-item interleaving at +1ms vs +24h | Identical PRESERVATION_UNVERIFIABLE; verdict text states the timestamp counts/attributes nothing | 53.32 |
| — | R2 same-millisecond collision | interleaving + dispatch at one timestamp | `resource_version` does not move across two state changes; verdict still UNVERIFIABLE | 53.33 |
| — | R2/R3 invisible item history | add-then-remove of an unrelated item inside the window | Final item set exactly T2+delta; verdict ITEM_PRESERVED_OBSERVED with `interleavingExcluded: false` stated | 53.34 |
| — | R4 collateral-effect counterexample | the update itself silently drops a coupon | Coupon gone at T4; item verdict unchanged (ITEM_PRESERVED_OBSERVED) — proving the verdict never covered coupons; the dimension travels on the verdict as uncertified | 53.35 |
| — | R4 unobservable-dimensions pin | — | The carried list names coupons, billing timing, mandatory-addon associations, contract terms, financial effects, schedule history | 53.36 |
| — | Unsupported classes | — | REMOVE_ADDON / CHANGE_PLAN / CHANGE_CADENCE / CANCEL all **REFUSED_UNSUPPORTED_OPERATION** before any transport call; class mismatches (add-existing, change-absent) likewise | 53.8–53.12 |
| — | Multi-plan dependence of additive plan payloads | site flag varied | disabled → plan price replaced; enabled → both plans retained (a different subscription than authorized) | 53.29 |
| — | Native idempotency (D5) | replay + key-reuse | same key+params replays without re-applying; same key+different params → 422 | 53.30 |
| — | Live adapter untouched | — | production builder still sends `replace_items_list=true`; adapter capability still `FULL_REPLACEMENT_ONLY` | 53.4 |

**Reading of the matrix (as corrected, §10).** The additive candidate's *item list* behaves as documented when concurrent activity touches items other than the target. But the honest claims stop there: same-item races are not merely unwinnable without CAS, they are **undetectable** under timestamp-only evidence (hence the CHANGE_QUANTITY ceiling); scheduled-change destruction inside the window is **invisible** at T4 (hence the R3 negative test, not a detection claim); and whole dimensions of authorized state — coupons, billing timing, contract terms, financial effects — are **outside the verdict's scope entirely** (hence ITEM_PRESERVED_* naming and the carried unobservable-dimensions list). The prototype's value is that its verdicts now say exactly this, in machine-readable fields, instead of implying a general preservation claim.

---

## 5. Phase 3 — Decision matrix

**Required proof** per approach (from the task), then evaluation. "Required specification changes" are *proposals for a future revision*, not changes made here — this PR touches no spec file and no core file (freeze guard passes unaided).

| Approach | Required proof | Concurrency | Authorization preservation | State verification | Financial determinacy | Recovery | Spec changes required |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Targeted update** (additive minimal dispatch) | Documented operation-level isolation + preserved unrelated state | Partial: item-additive races are structurally safe for *other-item* activity; same-item races unwinnable without CAS and — per G17-R2 — **not even detectable** under timestamp-only evidence | Holds at the *provider* level for ADD_ADDON per docs — but ADD_ADDON is **not an SCQ action** (G17-R1), so this row currently authorizes nothing in-scope; for CHANGE_QUANTITY it rests on unguaranteed same-ID semantics; schedules are a documented exception that must be gated by refusal | Item-subset only: T4 vs T2+delta comparison over items/quantities/prices/currency/status/plan. Coupons, billing timing, contract terms, financial effects and schedule history are unobservable to it (G17-R3/R4); detection is not prevention, and for the target item itself there is no detection | Estimate twin takes identical params, so a T2 estimate can re-derive the envelope basis; proration figures remain time/site-dependent and must be revalidated, never carried from T0 | Lost response → INDETERMINATE (no receipt promotion from matching state); native idempotency covers same-request retry for 30 min only; durable coordinator still required | **First, an SCQ action-schema decision**: ADD_ADDON support would be new normative/schema/capability/adapter/conformance work, separately approved — not an adapter flag. For in-schema classes, §6.17 would additionally need: scheduled-change refusal, item-subset T4 verification as a receipt precondition with its scope stated, same-item ceiling classification. No change in this PR |
| **Conditional write** | Provider-enforced atomic version/state precondition | Would be complete *if it existed* | Would be complete *if it existed* | Precondition rejection is itself the verification | Unchanged from targeted | Clean refusal semantics on version mismatch | §6.17 could admit `CONDITIONAL_WRITE` — **but the mechanism does not exist in the documented API (§2.5). Approach unavailable; not a matter of implementation effort** |
| **Full replacement** (current adapter dispatch) | Explicitly expanded authorization covering the actual replacement effect | Unsafe by construction (Finding 1; reproduced in 53.19) | Fails OPERATION scope by definition; only honest under TARGET_REPLACEMENT consent | Target-set verification actively misleads (it certified the Finding 1 deletion) | Determinable for the *replacement* effect, which is a larger effect than the quote described | As today | This is approach **D's** territory (G-14), not a fallback: **not selected, not enabled, not recommended by this package** |
| **Refusal** (current posture) | Required when none of the above can be established | Complete (nothing dispatches) | Complete (nothing dispatches) | — | — | Refusals are deterministic, pre-dispatch, `CONFIRMED_NON_EXECUTION`, zero durable attempts (test47) | None. **This remains the live posture** |

---

## 6. Phase 4 — Prototype summary and its exact boundaries

The prototype (`g17-targeted-update.ts`; mock; tests) implements: operation classification with fail-closed unsupported classes; the minimal additive builder (target item only — never the plan, never the retained set; `invoice_immediately=false` retained from the production posture); T2 drift and scheduled-change refusals with zero-dispatch guarantees; a single idempotency-keyed dispatch; lost-response INDETERMINATE with no re-dispatch; and a T4 verdict engine comparing the **visible item subset** against **T2 + authorized delta** (never target-set equality), reporting survived concurrent change as its own classification instead of absorbing it, and carrying its scope limits (`scope`, `interleavingExcluded: false`, `unobservableDimensions`, `inScqActionSchema`) as machine-readable fields on every verdict. After the §10 correction round it makes **no** classification use of `resource_version`.

Boundaries, stated plainly:

- It is **not** integrated with the SCQ quote/store/receipt machinery. It consumes a caller-supplied T0 snapshot and returns a classification; it issues no SCQ receipt. Receipt integration is part of the future architecture (§7), not of an evidence prototype.
- Its financial figures are the mock's ASSUMED rule A2 and are used for response shape only. No test asserts a provider financial truth.
- Its first version modeled `resource_version` as a fixed +1000 step and classified partly on the delta. **That inference is withdrawn (G17-R2): a timestamp delta is elapsed time, not a change count, and no part of it is "positive evidence of interleaved activity."** The corrected mock stamps versions from a controllable clock (collisions included) and the executor draws no classification from the version at all. There is nothing to "calibrate" in a future pilot either: the signal does not exist in that form.
- Simulated provider results are never described as live validation anywhere in this package, the code, or the tests.

---

## 7. Proposed adapter architecture (for a future, separately reviewed PR — not implemented here)

If — and only if — the §9 conditions are met for a specific operation class, the smallest honest adapter evolution is:

1. **Per-class capability — over SCQ actions only (G17-R1).** The adapter's mechanism declaration becomes a map from **SCQ ChangeAction** → capability, still module-private and getter-protected exactly as PR #14 built it. On today's evidence every entry remains `FULL_REPLACEMENT_ONLY` (refusal posture unchanged); `CHANGE_QUANTITY → TARGETED_UPDATE` becomes *discussable* only after vendor Q1/Q2 are answered in writing **and** the G17-R2 ceiling is given a receipt semantics (an operation whose preservation is unverifiable by construction cannot mint verified receipts). **ADD_ADDON does not appear in this map at all**: it is not a ChangeAction. Supporting it would require, in order, a normative decision to add the action, schema/types changes, capability semantics, adapter work, and conformance vectors — a separately approved program, not a consequence of this research. Quote creation records the class-specific capability; the commit gate consults the map, never caller input.
2. **Dispatch builder per class.** A `buildTargetedUpdateParams` sibling to `buildChargebeeUpdateParams` (which remains the full-replacement builder, untouched), emitting only the target item with `replace_items_list=false`.
3. **Gate sequence (unchanged order, one new stage).** Existing expiry / fingerprint / envelope / live-enabled / durable write-ahead gates stand. The preservation stage becomes: T2 re-read → identity/currency/item drift refusal → **scheduled-change refusal** → targeted dispatch → **T4 item-subset verification** feeding the existing core `verifyPostCommitState` at a new coverage level (baseline-plus-delta rather than full-item-set) whose name and receipt mapping state its item-subset scope (G17-R4), with PRESERVATION_VIOLATED mapping to a violated reconciliation outcome and PRESERVATION_UNVERIFIABLE / lost-response mapping to COMMITTED_UNVERIFIED / INDETERMINATE per the existing PR-7 taxonomy — never to a verified receipt. The scheduled-change refusal at T2 remains necessary but is **not sufficient** (G17-R3): a schedule created inside the window is destroyed invisibly, so a targeted dispatch on a subscription where schedules matter additionally needs either a provider guarantee / atomic precondition that does not currently exist, or authorization that explicitly covers schedule effects.
4. **Financial re-derivation at T2.** The estimate twin accepts the identical minimal params; the envelope is re-checked against a T2 estimate built from the *targeted* params, so the financial basis matches the dispatch that will actually occur. T0 figures never carry across a T2 re-read.
5. **Durable coordinator mandatory.** No targeted dispatch outside the existing write-ahead ledger; native idempotency key derived from the quote id as today.
6. **Kill criteria.** Any pilot observation of duplicate-entry or quantity-summed same-ID behavior, or of an undocumented schedule interaction, returns the class to refusal automatically — the capability map is data, and flipping an entry back is a one-line, test-pinned change.

---

## 8. Remaining unknowns, risks, and the vendor clarification request

**Unknowns that block progress, in order:**
1. Same-ID additive semantics (blocks CHANGE_QUANTITY entirely).
2. Whether *any* write-side precondition exists outside the published docs (blocks approach B definitively, in either direction).
3. Scheduled-change interaction for the *additive* mode specifically (the Impacts text is written for the endpoint generally; whether an addons-only additive call with no plan still deletes a legacy scheduled change is not stated separately).
4. ~~Live `resource_version` delta behavior under concurrent writes~~ — **retired (G17-R2):** no claim in the corrected package rests on version deltas, so their live behavior is no longer a blocking unknown. What would actually unblock the same-item ceiling is an operation-bound proof mechanism (a provider-enforced precondition, Q3, or an operation-level read-back), none of which is documented.
5. Proration/credit/invoice side effects of a minimal additive quantity change on a real site configuration (figures, not shapes).

**Risks if this package were over-read:** treating "add or update" wording as a guarantee (it is not); treating `resource_version` deltas as change counts or attribution (they are neither — G17-R2); treating ADD_ADDON's documented provider safety as an SCQ capability (it is not an SCQ action — G17-R1) or as evidence about CHANGE_QUANTITY (different semantics, different evidence); forgetting that item preservation ≠ schedule preservation ≠ financial preservation (three separate dimensions, separately gated, and only the first is even partially observable post-hoc — G17-R3/R4).

**Vendor clarification request (ready to send to Chargebee support / TAM; no part of it has been sent):**

> Subject: `update_for_items` with `replace_items_list=false` — same-item semantics, scheduled-change interaction, and write preconditions
>
> We are evaluating whether an operation-scoped subscription change can be executed without altering unrelated subscription state, and need written clarification on the Product Catalog 2.0 API:
>
> **Q1.** With `replace_items_list=false`, if `subscription_items` contains an `item_price_id` that already exists on the subscription, what exactly happens: (a) the existing entry's quantity is set to the supplied quantity, (b) a second entry is appended, (c) the quantities are summed, or (d) the request is rejected? Does the answer differ for plans vs addons, or by pricing model (`per_unit`, `flat_fee`, `tiered`, `volume`, `stairstep`)?
> **Q2.** If (a): is the supplied quantity absolute, and does a supplied `unit_price` replace the subscription-level override? What happens when quantity is omitted for an existing item?
> **Q3.** Does any subscription write endpoint accept an expected-state precondition (e.g. an expected `resource_version`, an `If-Match` header, or an equivalent) that atomically rejects the write if the resource changed after it was read? If not, is one planned?
> **Q4.** The update endpoint's Impacts documentation states an update deletes an existing scheduled change (Ramps disabled) or deletes/drafts ramps (compatibility mode). Does this apply identically to an addons-only call with `replace_items_list=false` that carries no plan and no scheduling parameters?
> **Q5.** In additive mode, are mandatory addons ever added, removed, or re-quantified as a side effect when the payload does not name them and no plan change is requested?
> **Q6.** With multi-plan subscriptions enabled and an addons-only additive payload, is the existing plan always retained unchanged (the docs state this for the plan's retention; we are confirming no plan-side repricing occurs)?
> **Q7.** Is there any documented ordering/atomicity guarantee when two `update_for_items` calls for the same subscription are processed concurrently, beyond idempotency-key replay of identical requests?
> **Q8.** For a per-unit quantity increase via additive mode, which response fields authoritatively state the incurred immediate obligation (as distinct from the next-invoice estimate and the amount due after credits)?

---

## 9. Recommendation and read-only pilot conditions

### A/B/C/D recommendation (Issue #30 decision tree)

- **A — TARGETED_UPDATE:** **Not adoptable for any in-scope SCQ action today (corrected per G17-R1).** ADD_ADDON has documented targeted semantics and a passing simulated adversarial matrix — as a *provider capability*. It is not an SCQ action, so there is nothing to adopt without a separate normative program adding it to the schema. Among the actions SCQ has, CHANGE_QUANTITY is the only candidate and it is doubly blocked: unguaranteed same-ID semantics (Q1/Q2) and the G17-R2 unverifiability ceiling. A remains the direction of travel, per class, only after §9's conditions.
- **B — CONDITIONAL_WRITE:** **Rejected on evidence.** No documented precondition exists (§2.5). `resource_version` does not qualify, and this package does not pretend otherwise. Revisit only if Q3's answer changes the record.
- **C — FULL_REPLACEMENT_ONLY + OPERATION refusal:** **RECOMMENDED — remains the live posture.** Nothing in this package weakens it; the prototype, the tests, and this memo all leave the adapter byte-identical and the refusal in force. G-17 stays **OPEN** as a standing limitation with a now-mapped exit path.
- **D — TARGET_REPLACEMENT authorization:** **Not pursued.** It remains the separate, deferred normative decision under G-14. Nothing here selects full replacement as a fallback, implicitly or otherwise.

**Completion-criterion statement:** this package provides a *verified, operation-specific path toward* safer execution (ADD_ADDON documented + simulated as a provider capability outside the current SCQ schema; CHANGE_QUANTITY wording-supported + vendor-blocked + evidence-capped) and a *rigorously supported conclusion* that the provider currently supplies no complete mechanism (no CAS; schedules destroyed by any update and the destruction is invisible post-hoc; removal and plan/cadence outside the targeted class). Both halves of the criterion are met at the evidence level available without live access; neither half authorizes a code change to the live adapter.

### Conditions required to proceed to a read-only pilot (all required; the pilot itself authorizes no mutation)

1. Vendor answers to Q1–Q4 received **in writing** and filed with this package; if Q1's answer is not "absolute set (a)" for per-unit addons, CHANGE_QUANTITY stays refused regardless of other answers.
2. A named Chargebee **test** site (never production) with multi-plan setting, Ramps setting, mandatory-addon site setting, and proration configuration recorded — the documented behaviors are configuration-dependent, so the pilot's claims must name the configuration they were observed under.
3. Read-only observation plan executed under Issue #12's existing gates: GET subscription / item prices and the **estimate** twin (`estimates/update_subscription_for_items`) with the exact minimal additive params, on synthetic subscriptions only; sanitized wire traces filed; each observation classified LIVE_API_VALIDATED / DOCUMENTATION_BACKED_SIMULATION / UNVERIFIED honestly. (Estimates are non-mutating but are still provider interactions requiring the site owner's authorization — none is given by this package.) **Scope limit (G17-R3): the pilot validates facts about payloads and responses; it cannot prove the absence of the scheduled-change race or of any invisible interleaving, and its report must say so.**
4. Same-ID behavior probed *only* through estimates and reads in the pilot; a **mutating** probe remains a separate decision requiring its own explicit authorization, an exact-commit preflight (PR #20 machinery) re-derived for the targeted params, a named reconciliation owner, and the durable ledger — i.e. Issue #12's NO-GO conditions, unrelaxed.
5. An independent reviewer reproduces the pilot's read/estimate results before any adapter PR is opened; the adapter PR itself is per-class (§7), failing-first, and keeps every non-pilot class refused.

**Unchanged safety gates:** `SCQ_LIVE_COMMIT_ENABLED` was never set; no live billing API request of any kind was made; G-17 is not relaxed; no package or specification is published by this work; Issue #12 remains NO-GO until its independently required conditions are satisfied.

---

## 10. Independent review corrections — G17-R1..R4 (this revision)

An independent review of this PR @ `ecc3ff5` verified the four-file isolated scope, the CI, the UNKNOWN same-ID treatment, the absent conditional write, the fail-closed classes, recommendation C, and Issue #12 NO-GO — and required four corrections before the package could be treated as a finished provider-mechanism assessment. All four are accepted. This round is documentation + mock/test clarification only: no live-adapter change, no spec change, no live call.

### G17-R1 — ADD_ADDON is not an SCQ operation

**Finding.** `core/types.ts` defines `ChangeAction` / `ChangeSpec` with exactly `CHANGE_QUANTITY`, `CHANGE_PLAN`, `CHANGE_CADENCE`, `CANCEL`. There is no `ADD_ADDON`. The prototype's own `G17Operation` union made its positive ADD_ADDON result read like a path an SCQ proposal could execute; it is not one.

**Correction.** Provider capability and in-scope SCQ protocol capability are now distinguished everywhere it matters: §1 answer, §3 matrix posture, §5 decision matrix, §7 architecture (the capability map ranges over SCQ actions only; ADD_ADDON would require a separately approved normative/schema/capability/adapter/conformance program), §9 recommendation A (not adoptable for any in-scope action today). In code, every verdict carries `inScqActionSchema`, the executor exports `SCQ_CHANGE_ACTIONS` mirrored from `types.ts`, and test 53.31 pins the schema **from the `types.ts` source text** so the distinction cannot silently drift. Among existing SCQ actions, CHANGE_QUANTITY remains unproven.

### G17-R2 — `resource_version` is a timestamp, not a change counter or causal attribution

**Finding.** The first version's mock advanced `resource_version` by a fixed +1000 per change; the executor classified `PRESERVED_VERIFIED` on an exact-step delta and treated a larger delta as proof of interleaving. A real timestamp delta measures elapsed time — a larger delta can be one later change, a small one several near-simultaneous changes — and no timestamp interpretation supports counting or attribution. §6's original "transferable claim" (a beyond-step delta is positive evidence of interleaving) is **withdrawn**.

**Correction.** The mock stamps `resource_version` from a controllable clock (D6 rewritten); multiple changes in one millisecond collide at one version (53.33 proves the version does not move across two changes). The executor makes **no** classification use of the version; it is reported as changed/unchanged colour with an explicit no-count/no-attribution note. Delta-magnitude irrelevance is tested directly (53.32: +1ms vs +24h classify identically). The material consequence is a **ceiling**: for CHANGE_QUANTITY, an interleaved same-item change overwritten by the dispatch is observationally indistinguishable from a clean run (53.2 and 53.20 now produce byte-identical T4 states and the same capped classification), so absent independent operation-bound proof the class is PRESERVATION_UNVERIFIABLE even when the target is observed in effect.

### G17-R3 — A read-only preflight cannot close the scheduled-change TOCTOU gap

**Finding.** A schedule created after T2 and deleted by the T3 dispatch leaves T4's `has_scheduled_changes=false` identical to the no-schedule baseline. The first version's 53.24 "caught" this only through the synthetic version increments — protection that cannot be inferred from live timestamps.

**Correction.** 53.24 is rewritten as an explicit **negative test**: schedule created inside the window at the same timestamp, dispatch deletes it (mock state proves the destruction), T4 is indistinguishable from baseline, and the verdict is ITEM_PRESERVED_OBSERVED *for the item subset* while itself declaring scheduled-change history unverifiable. The package now states plainly that ADD_ADDON is **not** authorization-preserving under all authorized-state dimensions merely because its item list is additive; §7's architecture adds that the T2 schedule refusal is necessary but not sufficient (a provider guarantee, an atomic precondition, or explicitly wider authorization would be needed); §9's pilot conditions state that a read-only pilot validates facts and **does not prove absence of this race**.

### G17-R4 — Scope of the post-hoc preservation verdict

**Finding.** `diffSnapshots` / `verify` inspect item IDs, quantities, unit prices, currency/status, plan identity, and a Boolean scheduling flag. They do not establish preservation of discounts/coupons, billing timing, mandatory-addon associations, contractual terms, or provider-side financial effects. A verdict named `PRESERVED_VERIFIED` invited translation into a general SCQ verified-receipt claim.

**Correction.** The positive classifications are renamed **ITEM_PRESERVED_OBSERVED** / **ITEM_PRESERVED_WITH_CONCURRENT_CHANGE**; every verdict carries `scope: "MOCK_VISIBLE_ITEM_SUBSET_ONLY"`, `interleavingExcluded: false`, and the `G17_UNOBSERVABLE_DIMENSIONS` list (discounts/coupons; billing timing; mandatory-addon associations beyond presence; contractual terms; credits/unbilled/invoice effects; payment method/metadata; scheduled-change history). Test 53.35 is the requested explicit counterexample: the update silently drops a coupon as a collateral effect, the coupon is gone at T4, and the item verdict is unchanged — demonstrating in executable form that the verdict never covered that dimension. 53.36 pins the list's contents. No verdict in this package may be translated into a general SCQ verified-receipt claim.

### What the correction round changes about the bottom line

Nothing about the disposition — **C stands, G-17 OPEN, Issue #12 NO-GO, live adapter untouched** — and one thing about the map: the exit path is narrower than the first version suggested. Of the four SCQ actions, none has a proven targeted mechanism; the one fully documented targeted behavior belongs to an operation SCQ does not have. The remaining work is unchanged in kind (vendor answers → read-only pilot under Issue #12's gates → separately reviewed per-class work) but its first step is now correctly stated: for ADD_ADDON, a *schema* decision precedes everything; for CHANGE_QUANTITY, vendor semantics (Q1/Q2) and an operation-bound proof mechanism (Q3) precede everything.
