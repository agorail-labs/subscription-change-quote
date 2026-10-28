# Phase 3 Evidence Summary — Live Chargebee Quoting Repair and Revalidation

- **Date:** 2026-10-27
- **Branch / commits:** `review/change-b-live-validation-tooling` —
  rebase `8fe298f` onto merged main `cde8faa`; repair `45498d4`;
  fixtures/regressions `2d3465c`; results addendum `cdb51bb`.
- **Environment:** Chargebee **test** site `arjunsamplecompany-test`;
  synthetic demo subscription `cbdemo__XpbKpmKUbu8d2cPS`. Credentials
  were env-only and are not recorded here or anywhere in this repo.
- **Scope of live calls:** GET subscription, GET item prices,
  POST `/estimates/update_subscription_for_items` (documented
  non-mutating estimate). No update/commit endpoint was called;
  `SCQ_LIVE_COMMIT_ENABLED` stayed `false`; zero provider mutations.
- **Companion record:** the full sanitized run report also exists
  outside the repo at
  `~/workspace/scq-live-validation-evidence/PHASE3-RUN-2026-10-27.md`;
  this file is the in-repo summary so the classifications in
  TEST-RESULTS.md are inspectable from the repo alone.

## Correction to the Oct 27 interim conclusion (explicit)

An interim Oct 27 report concluded the Chargebee estimate endpoint
required **item-indexed** array parameters
(`subscription_items[i][field]`) and that the field-grouped encoding
was a bug. **That conclusion was wrong and is retracted.** The 18-cell
isolation matrix below established the opposite: the field-grouped
encoding is the server's real (and documented) format, and the
item-indexed shape is silently ignored — its HTTP 200 responses
described a different item set than the one requested. The grouped
encoder in `chargebee-http.ts` was never the bug. This correction
also resolves the interim report's open item G3 ("addon change
produced no estimate delta"): the delta had never reached the server.

## 18-cell encoding isolation matrix (live, estimate-only)

Endpoint: POST `/estimates/update_subscription_for_items`.
Constants in every cell: `subscription[id]` nested,
`replace_items_list=true`, `prorate=true`,
`invoice_immediately=false`, `change_option=immediately`.
Varied only: array encoding (grouped vs indexed) × item set (plan
only / per_unit addon only / both) × quantities.

Findings (evidence source: LIVE for every row):

1. **Flat `subscription_id` → HTTP 400** "subscription[id] : cannot
   be blank" (`param_required`). The endpoint reads only the nested
   `subscription[id]`. This was the original demo failure's root
   cause; the estimate client is fixed.
2. **Grouped encoding is parsed and validated per item:** a listed
   per_unit item without a quantity → 400
   "subscription_items[quantity][1] : cannot be blank"; grouped
   requests produce estimates reflecting the REQUESTED items
   (unchanged baseline → next_invoice_estimate total 60900 with both
   item lines; addon 1→21 → prorated unbilled charge — see quote
   below). This is also the documented format ("pass parameters as
   `subscription_items[<param name>][<idx:0..n>]`").
3. **Indexed encoding is silently ignored:** every indexed cell
   returned HTTP 200 whose estimate did NOT reflect the requested
   items (addon quantity 21 → no charge; next-invoice lines missing
   the addon). Consistent with Chargebee's documented behavior of
   ignoring unrecognized parameters.
4. **The "on_off addon type" 400 is a per-item validation, not an
   encoding error:** "subscription_items[quantity][0] : This param
   should not be sent for on_off addon type" reproduced in EVERY cell
   where the flat_fee plan item's quantity differed from its current
   value (2 or 21; plan-only or with addon; either field order) and
   in NO other cell. Quantity present-but-unchanged (1) is accepted
   for the flat_fee item. Rule as evidenced: quantity is a settable
   dimension only of quantity-priced (per_unit) items; the server's
   "on_off addon type" wording is its label for a non-quantity-priced
   item (item [0] was the plan). Residual uncertainty: only
   quantity == current (== 1 here) was observed accepted for a
   flat_fee item; nothing stronger is claimed.

## Item-price metadata (live, GET /item_prices/{id})

- `cbdemo_business-plan-price`: pricing_model `flat_fee`, price
  59900, free_quantity 0, item_type plan.
- `cbdemo_vision-pro-addon-price`: pricing_model `per_unit`, catalog
  price 10000, free_quantity 0, item_type addon. The subscription
  item carries a unit_price override of 1000 (amount 1000 at
  quantity 1; free_quantity 0 follows arithmetically).

## Corrected live quote (through the SCQ adapter, real API)

- **Test ID:** T02-live. **Endpoint:** POST
  `/estimates/update_subscription_for_items`. **Source:** LIVE.
- **Scenario B — addon `cbdemo_vision-pro-addon-price` quantity
  1→21: QUOTE CREATED** (`scq_cblive_cf039fc8fef82714`),
  guaranteeMode REVALIDATE; coverage immediate REVALIDATE /
  recurring REVALIDATE / termEffect UNKNOWN / effectiveAt REVALIDATE
  (no EXACT anywhere).
  - `immediate {charge 185240, net 185240}` ←
    sum(`unbilled_charge_estimates[].amount`) − credit notes 0
    (member present, empty). Semantics: this is a **newly incurred
    unbilled obligation** (provider proration, 20 × 9262 at the run
    instant; the matrix run minutes earlier returned 185260 =
    20 × 9263 — proration is time-dependent). It is NOT an issued
    invoice, NOT a payment due at commit, and NOT cash collected;
    the adapter commits with `invoice_immediately=false`, so such
    charges are invoiced at the next billing cycle.
  - `recurring {previousAmount 60900, resultingAmount 80900}` ←
    per-item, pricing-model-justified: unchanged flat_fee plan at
    its provider-stated amount 59900 (once — quantity never
    multiplied) + per_unit addon (21 − free_quantity 0) ×
    subscription unit_price 1000.
  - `nextInvoiceEstimate: null` — the provider omitted
    `next_invoice_estimate` for this estimate; reported as absent in
    providerMetadata, never filled in and never mapped into the
    effect. (On the unchanged-baseline estimate the provider DID
    return it: total 60900, amount_due 60600 after credits_applied
    300 — the 300 reduces the amount DUE, not any price; a
    dropped-parameters variant returned total 59900 with the addon
    line missing, proving the total is not a recurring figure.)
- **Scenario A — plan quantity 1→21: REFUSED by the adapter before
  any estimate call** (`UNSUPPORTED_CHANGE`, citing the flat_fee
  metadata); the underlying provider validation error was
  reproduced separately in the matrix (finding 4).

## Classifications (live rows; mock rows stay SIMULATED_PASS)

| Row | Classification | Basis |
|---|---|---|
| L-GET (T01-live) adapter snapshot via real API | LIVE_PASS | snapshot matched the raw API (items, MRR 60900, resource_version fingerprint) |
| L-QUOTE (T02-live) adapter quote, per_unit addon scenario | LIVE_PASS | quote above, created end-to-end through the real API |
| L-REFUSAL flat_fee quantity change | live-verified | adapter pre-call refusal + provider 400 reproduced in the matrix |
| L-ESTIMATE plan-quantity via provider | provider-rejected (400, by its validation) | not an adapter failure; the adapter now refuses first |
| L-COMMIT (T03-live) | BLOCKED | not authorized, not attempted; live commit disabled |
| T14-live scheduling/Ramps | BLOCKED | unchanged |

## No-mutation state check

Before the run (raw GET): resource_version 1787888379461, active,
items [plan ×1 amount 59900, addon ×1 amount 1000],
has_scheduled_changes false. After the run (raw GET, independent of
the adapter): resource_version 1787888379461 (identical), items
identical, has_scheduled_changes false, updated_at unchanged
(1787888379). What was checked is exactly that one subscription
resource — its version, status, full item list, scheduled-changes
flag, and updated_at. An unchanged resource_version alone would not
prove every other provider resource unchanged; the stronger claim
made here rests on the call log of the phase itself: every call was
a GET or a documented non-mutating estimate POST, and the
update/commit endpoint was never called.
