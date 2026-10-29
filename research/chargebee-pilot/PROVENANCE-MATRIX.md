# Chargebee pilot — field-level financial provenance matrix

How every financial figure in an SCQ quote from the live Chargebee
adapter is sourced. "Direct" = returned by the provider in the estimate
response. "Computed" = derived by the adapter under a stated,
pricing-model-justified rule. Absence is a first-class outcome: a
dimension that cannot be established is **absent** (v0.6.2 reading:
UNKNOWN) and the quote is refused (`QUOTE_NOT_DETERMINISTIC`) — never
zero-filled, never substituted. All amounts are **minor units** of the
subscription's currency (`currency_code`, e.g. USD cents); the adapter
never converts units.

| Provider response field | Economic meaning | SCQ destination | Direct / computed | Determinacy & rules |
|---|---|---|---|---|
| `invoice_estimate.total` | Provider's estimate of the total of the invoice that *would* be issued for the change | `CommercialEffect.immediate.net` (base figure) | Direct | DETERMINED when present and numeric. Still an *estimate of an invoice total* — not a payment, not a collection. |
| `unbilled_charge_estimates[].amount` (sum) | Newly incurred **unbilled** obligation created by the change (invoiced at the next cycle under `invoice_immediately=false`) | `CommercialEffect.immediate.net` (base figure when `invoice_estimate` absent) | Direct (sum of stated elements) | DETERMINED only when the member is present AND every element carries a numeric `amount`. An element without an amount makes the dimension UNKNOWN — an element is never counted as 0 (21-n1, 13-neg1). An empty array is a provider-stated **0** (21-z1). |
| `credit_note_estimates[].total` (sum) | Credits the change would generate | Subtracted from the immediate base | Direct (sum of stated elements) | The member MUST be present for the net to be final: absent member ⇒ immediate UNKNOWN (21-n2, 13-neg2). An element without a numeric `total` ⇒ UNKNOWN. |
| `subscription_estimate.subscription_items[].amount` (sum) | Provider-stated post-change per-item amounts | `CommercialEffect.recurring.resultingAmount` | Direct | Used ONLY after `statedItemsAreComplete` verifies the stated list is the *entire* intended item set (same ids, no duplicates, matching quantities, amount on every item). A partial stated list is never summed as the result (21-n3, 13-fix11a–e). |
| Per-item computation (fallback for recurring) | Post-change price level reconstructed item by item | `CommercialEffect.recurring.resultingAmount` | Computed | Justified per pricing model only: unchanged item → its provider-stated `amount`; `flat_fee` → fixed price **once** (quantity never multiplied); `per_unit` → (quantity − free_quantity) × unit price, with unit price and free_quantity from the subscription payload / item-price metadata (subscription override beats catalog). `tiered` / `volume` / `stairstep` / unknown ⇒ contribution unjustifiable ⇒ recurring UNKNOWN ⇒ quote refused (21-n4). |
| Current `subscription_items[].amount` (sum) | Current price level | `CommercialEffect.recurring.previousAmount` | Direct | Included only when every current item states an amount; otherwise previousAmount is omitted (never estimated). |
| `next_invoice_estimate.total` | Next cycle's invoice total (line set can be incomplete) | `providerMetadata.nextInvoiceEstimate` **only** | Direct | **NEVER mapped into `immediate` or `recurring`.** It is a next-cycle figure, not the obligation incurred by this change. |
| `next_invoice_estimate.amount_due` | Next invoice amount due **net of credits** | `providerMetadata.nextInvoiceEstimate` **only** | Direct | **NEVER mapped.** Credits reduce what is *due*, not the subscription's price: recurring is never silently reduced by credits (21-p4: total 80900, amount_due 80600, recurring stays 80900). |
| `next_invoice_estimate.credits_applied` | Credits applied to the next invoice | `providerMetadata.nextInvoiceEstimate` **only** | Direct | Metadata only, for the same reason as amount_due. |
| `next_invoice_estimate.date` | Next invoice date | `providerMetadata.nextInvoiceEstimate` **only** | Direct | Metadata only. |
| `subscription.resource_version` | Provider state version (ms timestamp) | Quote precondition (`preconditions.subscriptionVersion`); commit staleness check | Direct | Detection only — no documented compare-and-swap exists on `update_for_items`, so consistency stays BEST_EFFORT (TOCTOU window documented in COMMIT-RECOVERY-SAFETY.md). |
| `subscription.has_scheduled_changes` | Pre-existing scheduled changes exist | `providerMetadata` + warning | Direct | Surfaced, never absorbed: an immediate update can supersede scheduled changes; termEffect stays UNKNOWN (21-n6). |
| Item-price metadata (`pricing_model`, `price`, `free_quantity`) via `GET /item_prices/{id}` | Authoritative pricing terms | Interpretation input; `providerMetadata.pricingModels` | Direct | Decides pre-call refusals (flat_fee quantity change, 21-n5) and which computations are justified. A failed metadata lookup leaves the model unknown ⇒ dependent dimensions fail closed. |
| Update response `invoice.total` / `unbilled_charges[].amount` (mocked commit path only) | Actual incurred figure reported by the mutating call | `committedEffect.immediate` | Direct | Used ONLY from actuals; the pre-mutation estimate is never substituted. Missing/incomplete ⇒ outcome INDETERMINATE in this adapter (frozen v0.6.1 receipt type has no committed-but-unverified state — see COMMIT-RECOVERY-SAFETY.md). |
| Post-commit re-read `subscription_items[].amount` | Actual post-commit price level | `committedEffect.recurring` | Direct | Absent member / empty list / any item without a stated amount ⇒ UNDETERMINED, never a verified zero (13-rec5/rec6). The re-read item set must first verify as exactly the intended set, else INDETERMINATE with no receipt (21-c7/c9). |

## Determinacy summary (v0.6.2 vocabulary, reporting only)

- **DETERMINED**: a figure above marked direct, or computed under its
  stated rule with all terms present. A determined **zero** is a real
  zero (empty provider members, or a stated amount of 0) and is
  preserved as `0`.
- **UNKNOWN**: any source member absent, any element incomplete, any
  pricing model unsupported, any term (free_quantity / unit price)
  unresolvable. UNKNOWN bounded dimensions refuse the quote/commit —
  the frozen v0.6.1 envelope would coerce absence to 0, so the adapter
  refuses *before* the envelope is consulted.
- **NOT_APPLICABLE**: not used for financial dimensions in this
  adapter. TERM_END/DATE scheduling is refused as UNSUPPORTED_CHANGE
  (deprecated parameters / early-access Ramps), which is a capability
  refusal, not an applicability claim about a financial dimension.
