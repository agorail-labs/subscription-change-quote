# Chargebee pilot run — mocked mode

Generated: 2026-10-29T13:28:08.313Z · Site: pilot-test (mocked) · Subscription: pilot-sub-001
Proposal: CHANGE_QUANTITY pilot-addon-vision 1 -> 21

## Steps
- [pass] retrieve subscription — status=active, items=2, version=rv:1700000000000
- [pass] build SCQ snapshot — recurring=60900 USD
- [pass] construct proposal — CHANGE_QUANTITY pilot-addon-vision 1 -> 21, IMMEDIATE
- [pass] provider-backed quote (estimate only) — quote scq_cblive_cf1490c71e2a3aa1; immediate.net=20000; recurring=80900
- [pass] field-by-field comparison (normalized vs raw) — 6/6 fields match

## Field-by-field comparison (normalized quote vs raw provider estimate)

| Field | Provider source | Raw-derived | Normalized | Match |
|---|---|---|---|---|
| immediate.net | sum(unbilled_charge_estimates[].amount) − sum(credit_note_estimates[].total) | 20000 | 20000 | yes |
| recurring.resultingAmount | subscription_estimate.subscription_items[].amount (provider-stated; verified complete against the intended item set) | 80900 | 80900 | yes |
| recurring.previousAmount | sum of current subscription_items[].amount (provider-stated) | 60900 | 60900 | yes |
| currency | subscription.currency_code | "USD" | "USD" | yes |
| nextInvoiceEstimate isolation | next_invoice_estimate.total / amount_due | null | null | yes |
| provenance recorded for every determined dimension | adapter financialProvenance | {"immediate":"sum(unbilled_charge_estimates[].amount) − sum(credit_note_estimates[].total)","recurring":"subscription_estimate.subscription_items[].amount (provider-stated; verified complete against the intended item set)"} | {"immediate":"sum(unbilled_charge_estimates[].amount) − sum(credit_note_estimates[].total)","recurring":"subscription_estimate.subscription_items[].amount (provider-stated; verified complete against the intended item set)"} | yes |

## Capability classifications

| Capability | Classification | Basis |
|---|---|---|
| retrieve subscription + snapshot | SIMULATED_PASS | mocked transport fixture (pilot mock) |
| estimate-backed quote | SIMULATED_PASS | mocked transport fixture (pilot mock) |
| normalized-vs-raw field comparison | SIMULATED_PASS | harness consistency check — the adapter's own interpretation function re-applied to the captured raw estimate (shares interpretation code with the adapter, so correlated interpretation defects are NOT detectable here; independent verification is the test-only oracle exercised in test22) |
| live commit | BLOCKED | prohibited in this pilot; harness constructs the adapter with liveCommitEnabled=false in both modes; SCQ_LIVE_COMMIT_ENABLED untouched |
| mocked commit-path + recovery behavior | DOCUMENTATION_SUPPORTED | exercised by test21/test13 mocked suites, not by this read-only harness run |

Transport: 8 calls, 1 estimate calls, **0 mutating calls** (all counts observed in the transport log).
Observed operations: retrieve_subscription ×3, get_item_price ×4, estimate_update_for_items ×1.
