# Phase 1 — Chargebee API Contract Audit (Product Catalog 2.0)

Method: current official documentation at apidocs.chargebee.com, re-read 2026-10-27.
Evidence levels: **DOCUMENTATION_SUPPORTED** = the current docs state it;
**HISTORICAL_LIVE** = observed in the prior v0.5-LIVE cycle and recorded in
`research/EVIDENCE.md` (not re-exercised in this run); **UNVERIFIED** = neither.
No claim in this audit is LIVE evidence from this run — no credentials were available.

Endpoints referenced:
- Retrieve: `GET https://{site}.chargebee.com/api/v2/subscriptions/{subscription-id}`
- Estimate update: `POST https://{site}.chargebee.com/api/v2/estimates/update_subscription_for_items`
- Update: `POST https://{site}.chargebee.com/api/v2/subscriptions/{subscription-id}/update_for_items`
- Create ramp: `POST https://{site}.chargebee.com/api/v2/subscriptions/{subscription-id}/create_ramp`

---

## A1. Wire format and authentication

| Claim | Endpoint | Doc URL | Evidence | Consequence for SCQ |
|---|---|---|---|---|
| REST API, HTTP Basic Auth (API key as username, empty password), form-encoded requests, JSON responses; timestamps are Unix epoch seconds; responses wrap resources (`{subscription: {...}}`) | all | https://apidocs.chargebee.com/docs/api/getting-started | DOCUMENTATION_SUPPORTED | The live adapter (`src/live/chargebee-http.ts`) implements exactly this; simulator adapters model none of it. |

## A2. Q1 — Does the update estimate leave provider state unchanged?

| Claim | Endpoint | Doc URL | Evidence | Consequence |
|---|---|---|---|---|
| Estimate operations do not make changes in Chargebee. For the sibling create-estimate the docs state this verbatim ("Estimate operations do not make any changes in Chargebee; hence this API does not create an actual customer or subscription record"); the update estimate is in the same estimate family and returns an `Estimate` object only. | POST /estimates/update_subscription_for_items | https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription ; https://apidocs.chargebee.com/docs/api/estimates/estimate-for-creating-a-customer-and-subscription | DOCUMENTATION_SUPPORTED (family-level statement; the update-estimate page itself does not repeat the sentence verbatim) | SCQ Rule 6.1's quote-non-mutation requirement is satisfiable on Chargebee via the estimate endpoint — **but it was not live-verified in this run** (BLOCKED). The historical v0.5-LIVE cycle did observe estimate/commit agreement, which is consistent with non-mutation but is not itself a mutation check. **Update (Phase 3, 2026-10-27): estimate non-mutation for the read/estimate scope WAS live-verified — subscription state (resource_version, updated_at, items) was identical before/after every estimate call in the Phase 3 run; see `evidence/PHASE3-EVIDENCE-SUMMARY.md`. This claim's classification is unchanged.** |
| Caveat: on the *update* operation, `auto_collection`, `shipping_address`, `po_number`, and subscription-level custom fields "always take effect immediately" regardless of `change_option`. An adapter that piggybacks such fields onto a "scheduled" update would partially apply immediately. | POST update_for_items | https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items (`change_option` constraints) | DOCUMENTATION_SUPPORTED | The SCQ live adapter sends none of those fields. Any future adapter must treat them as immediate-effect fields, not schedulable ones. |

## A3. Q2 — Which fields are authoritative?

| Object | Authoritative fields | Doc URL | Evidence | Consequence |
|---|---|---|---|---|
| Subscription | `subscription_items[]` (`item_price_id`, `quantity`, `unit_price`, `amount`), `status`, `current_term_start/end`, `next_billing_at`, `currency_code`, `resource_version`, `has_scheduled_changes`, `has_scheduled_advance_invoices`, `mrr` | https://apidocs.chargebee.com/docs/api/subscriptions/retrieve-a-subscription ; subscription object reference | DOCUMENTATION_SUPPORTED | There is **no single authoritative "resulting recurring total" field** on the subscription/estimate for this operation — recurring amount must be computed from item `amount`/`unit_price × quantity`. (Consistent with HISTORICAL_LIVE note in EVIDENCE.md: "the adapter had to calculate the normalized recurring total from item-price/quantity data.") SCQ's normalization does real work here. |
| Estimate | `subscription_estimate`, `invoice_estimate`, `next_invoice_estimate`, `credit_note_estimates`, `unbilled_charge_estimates` — which members are present is conditional (see A4) | https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription | DOCUMENTATION_SUPPORTED | A consumer that reads only `invoice_estimate.total` will be wrong in several documented cases. |
| Update response | Returns `subscription`, `customer`, optional `invoice`, optional `unbilled_charge`, optional `credit_note` | https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items (Returns) | DOCUMENTATION_SUPPORTED | Post-commit reconciliation must read the returned invoice/unbilled/credit-note objects and/or re-retrieve the subscription; the subscription object alone does not carry the immediate financial effect. |

## A4. Q3 — Are preview and commit directly comparable?

**Only partially — DOCUMENTATION_SUPPORTED limitations:**

1. No immediate invoice is generated (hence no `invoice_estimate`) when: `end_of_term` is
   true, `prorate` is false, no plan/addon item prices change, or for quantity
   **downgrades**. In those cases `next_invoice_estimate` is returned instead.
2. `unbilled_charge_estimates` is returned **only** when `invoice_immediately=false`;
   `credit_note_estimates` only for this update-estimate operation.
3. Tax calculation in the estimate is **ignored** unless customer `taxability` is true
   and billing/shipping address / VAT parameters are supplied.
4. `use_existing_balances` defaults to true: balances (promotional/refundable credits,
   excess payments) are folded into the estimate — a drift source that lives outside
   the subscription resource and therefore outside any subscription fingerprint.
5. `prorate` and `invoice_immediately` both default to **site settings** when omitted.

Consequence: preview↔commit comparability is real but conditional and shape-varying
(also HISTORICAL_LIVE: EVIDENCE.md item 2, "estimate response shape varies"). SCQ's
`CommercialEffect` normalization + REVALIDATE envelope is a defensible way to consume
this; a claim that the estimate *pins* the commit is not supported (see A8).

## A5. Q4 — `resource_version` and compare-and-swap

| Claim | Doc URL | Evidence | Consequence |
|---|---|---|---|
| `resource_version` is "updated with a new timestamp in milliseconds for every change made to the resource"; present only if the resource was updated after 2016-09-28; documented use is ordering webhook events (`rv1 > rv2`). | https://apidocs.chargebee.com/docs/api/subscriptions (subscription object); events/webhooks docs | DOCUMENTATION_SUPPORTED | Suitable for stale-state **detection** (monotonic timestamp comparison), which is how the live adapter uses it (`rv:<n>` fingerprint). Millisecond granularity means two changes inside one millisecond are not distinguishable by this field alone — a real, if narrow, detection gap the simulator's content hash does not have. |
| No precondition parameter (`If-Match`, expected `resource_version`, or equivalent) is documented on update_for_items; the parameter list was read in full. | https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items | DOCUMENTATION_SUPPORTED (absence in the documented contract) + HISTORICAL_LIVE (v0.5-LIVE: a stale `If-Match` header was ignored and the write applied) | **No CAS exists in the documented contract. `ConsistencyGuarantee` must remain BEST_EFFORT; ATOMIC would be a false claim.** SCQ's existing posture here is correct. |

## A6. Q5 — Effective-date / term-end scheduling: current vs deprecated

This is the audit's largest finding. The simulator and the existing SCQ Chargebee
adapter were built around mechanisms whose current documented status is:

| Mechanism | Current documented status | Doc URL | Evidence |
|---|---|---|---|
| `end_of_term` boolean on update_for_items | **Deprecated** — "use the Create a ramp API instead"; if passed together with `change_option`, `change_option` wins. (On the estimate page it is described as deprecated in favor of `change_option` — the two pages do not fully agree, itself a documentation inconsistency worth noting.) | update + estimate pages above | DOCUMENTATION_SUPPORTED |
| `change_option=end_of_term` | **Deprecated** — use Ramps. | update-subscription-for-items (`change_option`) | DOCUMENTATION_SUPPORTED |
| `change_option=specific_date` + `changes_scheduled_at` (future) | **Deprecated for scheduling changes** — use Ramps. `changes_scheduled_at` remains supported for **backdating** under site prerequisites (backdating enabled, date ≥ `current_term_start`, within one billing period, etc.). | update-subscription-for-items (`changes_scheduled_at`) | DOCUMENTATION_SUPPORTED |
| `effective_from` as a parameter of update_for_items | **Not present** in the current documented update_for_items parameter list at all. `effective_from` is the required parameter of **Create a ramp**. | update page (full parameter list read); https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp | DOCUMENTATION_SUPPORTED |
| Ramps | **Early Access** — "Request access, if it isn't enabled on your Chargebee Billing site." Max 12 upcoming ramps, 100 total; `effective_from` must be future, within 5 years, ≥24h between consecutive ramps; cannot create for paused/cancelled subscriptions or subscriptions with advance invoice schedules; event-based charges cannot be added via ramps. | https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp ; ramps overview | DOCUMENTATION_SUPPORTED |

Consequences for SCQ (recorded, **not** silently fixed — the spec is frozen):

- The simulator's `UpdateForItemsInput.effectiveFrom` and its comment claiming
  `update_for_items` accepts `effective_from` do not match the current documented API.
- SCQ's `EffectiveIntent.TERM_END`/`DATE` support claims for Chargebee rest, per current
  docs, on deprecated parameters or on an early-access API the reference implementation
  does not call. HISTORICAL_LIVE evidence (v0.5-LIVE) shows `end_of_term` worked when
  tested; deprecated-but-functional is the accurate characterization today.
- The new live adapter therefore supports **IMMEDIATE only** and refuses TERM_END/DATE
  before any provider call (T14). That is a narrower claim than the simulator adapter
  makes — deliberately.

## A7. Q6 — Native idempotency

| Behavior | Doc URL | Evidence | Consequence |
|---|---|---|---|
| Header `chargebee-idempotency-key`, ≤100 chars; UUID recommended; replay signaled by response header `chargebee-idempotency-replayed: true` | https://apidocs.chargebee.com/docs/api/idempotency | DOCUMENTATION_SUPPORTED | Live adapter derives the key deterministically from the SCQ quote id (`scq-<quoteId>`, ≤100 chars) so a legitimate retry of the same commit re-uses it. |
| **Window: 30 minutes.** Same key + same parameters within the window = replay of the original response. | same | DOCUMENTATION_SUPPORTED | Native idempotency is **not** a durable exactly-once mechanism. SCQ receipt replay has no such window but is bounded by QuoteStore lifetime instead (see T13). Neither alone is sufficient; a production deployment needs both plus a durable store. |
| Same key, **different** parameters (URI path, body, headers compared) → **422**. | same | DOCUMENTATION_SUPPORTED | A retry must reproduce the request byte-for-byte in the compared components; "same intent, slightly different request" is an error, not a replay. |
| Concurrent duplicate while the original is in flight → **409** with `retry-after`. | same | DOCUMENTATION_SUPPORTED | Callers must honor `retry-after`, not immediately re-fire. |
| **5xx errors are cached** under the key: retrying with the same key returns the same 5xx; reprocessing requires a **new** key. | same | DOCUMENTATION_SUPPORTED | "Retry with the same key until it works" is wrong for 5xx. And a new key after an ambiguous 5xx re-opens double-mutation risk unless state is reconciled first — the adapter's fail-closed indeterminate path exists for exactly this. |
| **Estimate APIs do not support idempotency.** | same | DOCUMENTATION_SUPPORTED | Harmless for safety (estimates are non-mutating per A2) but means estimate calls cannot be deduplicated natively. |
| Empty key or key >100 chars → 400. GET requests are inherently idempotent. | same | DOCUMENTATION_SUPPORTED | Key hygiene is the caller's job. |
| Network timeout (no response at all) | — (not addressed by the idempotency page) | UNVERIFIED at the documentation level | The docs do not state what a client should conclude from a lost response. The safe protocol (implemented): classify indeterminate, re-read state, never blindly re-issue. T07 exercises this against the mock. |

## A8. Q8 — Which SCQ GuaranteeCoverage assertions are supported?

Existing simulator-backed Chargebee adapter claims (chargebee-adapter.ts
`capabilitiesFor`): CHANGE_QUANTITY = EXACT on all four dimensions; CHANGE_PLAN /
CHANGE_CADENCE / CANCEL = EXACT financial + EXACT effectiveAt, termEffect UNKNOWN
(CANCEL quote-level: EXACT evergreen / UNKNOWN committed-term).

| Assertion | Verdict | Basis |
|---|---|---|
| immediateFinancialEffect EXACT | **Not supported by documentation.** No pinning parameter is documented (no proration_date analogue; `effective_from` belongs to Ramps). Estimate↔commit agreement was observed once historically for one configuration ($840 case, EVIDENCE.md) — a single observation is not a guarantee mechanism. Site-setting defaults, balances, conditional tax, and the prorate caveat (A9) are all documented drift sources between two separate calls. | DOCUMENTATION_SUPPORTED (absence of mechanism + documented drift sources); HISTORICAL_LIVE (one agreeing case) |
| recurringFinancialEffect EXACT | **Not supported by documentation**, same basis. Recurring must be computed from items (A3); nothing pins it. | as above |
| effectiveAt EXACT (IMMEDIATE) | Weakly supported: "immediately" is the default change_option semantics. For TERM_END/DATE the underlying mechanisms are deprecated / early-access (A6), so EXACT effectiveAt for scheduled intents is **UNVERIFIED** against the current contract. | DOCUMENTATION_SUPPORTED / UNVERIFIED |
| termEffect EXACT for CHANGE_QUANTITY | **Not supported.** Documented term interactions (`force_term_reset`, automatic term reset when billing period changes, contract-term parameters requiring Contract Terms enablement) mean term consequences are not fully derivable from the estimate/update pair. UNKNOWN is the honest value. | DOCUMENTATION_SUPPORTED |
| termEffect UNKNOWN for committed-term CANCEL | Supported as the honest posture (unchanged). Contract Terms remain a site-enabled feature; no new evidence in this run. | DOCUMENTATION_SUPPORTED + UNVERIFIED (behavior) |
| ConsistencyGuarantee BEST_EFFORT (never ATOMIC) | **Supported.** No CAS in the documented contract (A5). | DOCUMENTATION_SUPPORTED + HISTORICAL_LIVE |

**Bottom line:** the live adapter reports REVALIDATE / REVALIDATE / UNKNOWN /
REVALIDATE and refuses overall EXACT requests. The simulator adapter's broader EXACT
claims are the single largest spec-vs-current-docs discrepancy found (see
LIMITATIONS-AND-GAPS.md, D-1).

## A9. Q7 — `replace_items_list`, scheduled changes, Ramps, addons, site settings

| Hazard | Documented behavior | Doc URL | Consequence |
|---|---|---|---|
| `replace_items_list` default **false** | Without it, provided items are **added**: with a plan included and multi-plan disabled the existing plan price is replaced but addons accumulate; with addons only, the plan is always retained; mandatory addons survive replacement unless listed in `mandatory_items_to_remove`. | update page | An adapter sending only the changed item (the natural reading of the simulator's model) would silently retain/accumulate addons live. **The live adapter always sends the full list with `replace_items_list=true`** (asserted in T03). The simulator has no such parameter at all — its "full list replaces" behavior is an assumption the real API only honors when explicitly requested. |
| Existing scheduled changes | The update docs cross-reference "Impacts on existing scheduled changes"; the subscription exposes `has_scheduled_changes`. When Ramps compatibility mode is on, the flag reflects scheduled ramps. | update page; subscription object | An immediate update on a subscription with scheduled changes can interact with/supersede them. SCQ does not model this; the live adapter surfaces `has_scheduled_changes` + a warning in quote metadata and keeps termEffect UNKNOWN (T14). |
| Ramps restrictions | Early access; limits and restrictions in A6. | ramps docs | Any SCQ scheduling story on Chargebee now runs through a gated, separate resource — portability claims for DATE/TERM_END cannot be validated on a default test site. |
| Prorate caveat | If a previous change in the same term had `prorate=false` and only items/prices changed, a later `prorate=true` change creates **no credits**. | estimate + update pages | Two sequential SCQ commits in one term can produce financial effects neither quote predicted. Not modeled by SCQ or the simulator. |
| Site settings as defaults | `prorate`, `invoice_immediately` default from site settings; backdating, Contract Terms, multi-plan, calendar billing, metered billing, Net D are all site-gated features. | throughout | Identical API calls can behave differently on two sites. SCQ capability reporting is adapter-instance-scoped, not site-scoped — a real portability gap (LIMITATIONS D-6). The live adapter pins `prorate=true` and `invoice_immediately=false` explicitly rather than inheriting site defaults. |
| Scheduled-update partial immediacy | `auto_collection`/`shipping_address`/`po_number`/custom fields apply immediately even in a scheduled update (A2). | update page | "Scheduled" does not mean "nothing happens now" if those fields are present. |

## A10. Endpoint-name drift in the simulator

The simulator models `POST /subscriptions/{id}/update_for_items`,
`POST /estimates/update_subscription_for_items` under the names `update_for_items` /
`update_subscription_for_items`-style comments that mostly match, but its header also
references the older `POST /subscriptions/{id}/update_for_items?estimate=true`-style
preview and a `cancel_for_items` flow whose current documented parameter set (not
re-audited in depth here; cancellation was out of the validated scope of this run)
should be re-checked before any future reliance. The live adapter uses only the three
endpoints listed at the top of this audit, whose current documentation was read in full
for retrieve/estimate/update/idempotency.
