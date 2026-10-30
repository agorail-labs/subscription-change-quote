# Chargebee exact-commit preflight — scq_cblive_4cb2bdb77b26ab23

Generated: 2026-10-30T14:58:51.019Z · Transport origin: injected · **Overall: NO-GO**

## Identity and binding
- Provider/site: chargebee / pilot-test (approved for read-only validation: yes — per-run entry, configuration validation only)
- Tenant mode: UNVERIFIED
- Subscription: pilot-sub-001 (synthetic-fixture designation: yes)
- Quote: scq_cblive_4cb2bdb77b26ab23, created 2026-10-30T14:58:51.016Z, expires 2026-10-30T15:03:51.016Z, status ACTIVE
- Quote-origin binding (issuance record): ESTABLISHED (issued against site pilot-test, subscription pilot-sub-001)
- Fingerprint: stored rv:1700000000000 · current rv:1700000000000 (resource_version 1700000000000)
- Action: CHANGE_QUANTITY → target items pilot-plan-business×1, pilot-addon-vision×21

## Hypothetical mutation (the exact request a future commit would issue)
- Parameters (derived by the adapter's own request builder): replace_items_list=true, prorate=true, invoice_immediately=false, change_option=immediately
- Idempotency key (original, stored): scq-scq_cblive_4cb2bdb77b26ab23
- Canonical request hash: ae8a7bec519c1f95f61b443e290d02957d9c16a20b126eeada4adfa1821bef81
- Matches the authorized resulting item set (full multiset vs the independent re-read): yes

```
subscription_items%5Bitem_price_id%5D%5B0%5D=pilot-plan-business&subscription_items%5Bitem_price_id%5D%5B1%5D=pilot-addon-vision&subscription_items%5Bquantity%5D%5B0%5D=1&subscription_items%5Bquantity%5D%5B1%5D=21&replace_items_list=true&prorate=true&invoice_immediately=false&change_option=immediately
```

## Independent provider re-read
- Status active · currency USD · item set complete: yes
- Scheduled changes: false · scheduled advance invoices: false (UNKNOWN means the read carried no such data — not an affirmative none)
- Unbilled-charge visibility: UNKNOWN · credit visibility: UNKNOWN (the read-only allowlist exposes no enumeration)

## Financial report (four distinct quantities — never substituted for one another)
- **incurred_immediate_obligation**: 20000 minor units (USD) — DETERMINED, estimated; source: estimate unbilled_charge_estimates (prorated charges landing as unbilled charges).
- **post_change_recurring_price**: 80900 minor units (USD) — DETERMINED, estimated; source: estimate subscription_items stated amounts / implemented per-item pricing.
- **next_invoice_estimate**: not established — UNKNOWN, estimated; source: estimate next_invoice_estimate.total. Missing: the estimate carries no next_invoice_estimate — the next-invoice total is a distinct quantity and is never back-filled from the recurring figure.
- **amount_due_after_credits**: not established — UNKNOWN, estimated; source: estimate next_invoice_estimate.amount_due (net of credits_applied). Missing: no next_invoice_estimate amount_due is established; unbilled-charge/credit visibility through the read-only allowlist is insufficient to derive it.

## Side effects and limits
- invoice_immediately=false does not mean there is no financial consequence: the change's charges land as unbilled charges and are invoiced at the next term renewal.
- Proration: the adapter sends prorate=true with change_option=immediately, so mid-term quantity/plan changes accrue prorated charges for the remainder of the current term (the incurred immediate obligation in this report).
- Unbilled charges already outstanding are invoiced at the next cycle alongside this change's charges; the read-only allowlist exposes no unbilled-charge enumeration, so their total is not established here.
- Credits: an amount due net of credits is established only from a provider next_invoice_estimate carrying credits_applied; subscription credit balances are not enumerable through the read-only allowlist.
- Scheduled changes: the adapter sends no cancellation or neutralization of pre-existing scheduled changes; a subscription with scheduled changes is a preflight blocker, not a detail.
- Mandatory addons: the adapter sends NO mandatory_items_to_remove; mandatory addons attached to the target plan survive replace_items_list=true and appear in the post-commit item set — an unlisted item in the current set is a blocker here.
- There is no atomic rollback. If a commit's outcome is wrong, reversal is a NEW, separately authorized transaction (itself subject to proration and provider rules) and may incur further financial consequences; reconciliation reporting a violation does not undo anything.

## Checks
- [PASS] live_commit_flag_absent: SCQ_LIVE_COMMIT_ENABLED is not set to true in the preflight environment
- [PASS] site_approved: configured site "pilot-test" exactly matches a per-run approved-site entry (configuration validation only — not provider attestation of tenant mode)
- [UNKNOWN] operator_attestation: no operator attestation of actual test-tenant ownership/mode was supplied; a test-looking site name is not proof of tenant safety, so tenant mode stays UNVERIFIED
- [PASS] quote_exists_durably: the quote exists in the authoritative durable store
- [PASS] provider_binding: stored provider binding is chargebee
- [PASS] quote_origin_binding: quote origin is established by its issuance record: issued against site "pilot-test" for subscription "pilot-sub-001", digest-bound to the stored quote — the same site identity binds this run's request, re-read, and ledger
- [PASS] quote_not_expired: quote expires at 2026-10-30T15:03:51.016Z
- [PASS] synthetic_designation: subscription id "pilot-sub-001" carries a synthetic-fixture designation (a designation is a scoping signal, not proof of tenant safety)
- [PASS] no_unresolved_attempts: no unresolved durable attempt exists for this quote or subscription
- [PASS] idempotency_key_coherence: the stored idempotency key is the original adapter-derived key for this quote; it is reported, never regenerated
- [PASS] provider_subscription_identity: the provider re-read returned the bound subscription "pilot-sub-001"
- [PASS] fingerprint_stable: provider fingerprint is unchanged since quote time (rv:1700000000000)
- [PASS] item_set_complete: the full current item collection was read with id, quantity, and amount for every entry
- [PASS] request_matches_proposal: the stored dispatch target is exactly the full resulting item multiset the recorded proposal authorizes over the independently re-read current item set (every item's id and quantity compared, not just the changed item)
- [PASS] target_covers_current_items: every current item is present in the target set
- [PASS] scheduled_changes: the provider read reports no scheduled changes
- [PASS] scheduled_advance_invoices: the provider read reports no scheduled advance invoices
- [PASS] item_prices_readable: every involved item price was read
- [PASS] pricing_models_supported: all involved pricing models are implemented (flat_fee / per_unit)
- [PASS] envelope_still_satisfied: the fresh estimate sits inside the quote's acceptance envelope

## Observed transport
- exact-commit preflight evidence (this run): SIMULATED_PASS — caller-supplied (injected) transport: this evidence validates procedure and code paths, never live provider behavior — provenance is structural and cannot be upgraded by a caller-supplied label
- zero observed mutations: established from the observed transport log — observed 4 dispatched call(s): 4 read-only/estimate, 0 mutating, 0 rejected pre-dispatch; update_for_items dispatched 0 time(s)
- Running this preflight persisted no mutation intent (read-only store lookups only).

## Readiness (COMMIT-RECOVERY-SAFETY conditions)
- Condition 1 — v0.6.2 Chargebee migration complete AND the v0.6.2 specification/release approved: **UNVERIFIED** — specification/release approval is a human act separate from code merges; it cannot be inferred from PRs #17–#19 being merged, and none was supplied (evidence: no release-approval record supplied)
- Condition 2 — Durable idempotency storage implemented and recovery-tested: **PASS** — durable storage and recovery are implemented (PR #17) and rehearsed end to end over mocked transports — SIMULATED evidence; it does not prove durable exactly-once provider execution (evidence: mocked rehearsal 14/14 scenarios (runRehearsal() in this process (mocked)))
- Condition 3 — Executed preflight for the exact commit (this report): **UNVERIFIED** — Condition 3 is not met — the transport was caller-supplied (injected/simulated evidence): only the preflight's own internally constructed guarded real-network transport produces real-tenant evidence, and no caller-supplied label changes that; operator attestation of actual test-tenant ownership/mode was not supplied (tenant mode UNVERIFIED) (evidence: this report was produced over a caller-supplied (injected) transport)
- Condition 4 — Named reconciliation owner for unresolved outcomes: **BLOCKED** — software cannot name a reconciliation owner; the field stays blank until a human supplies one who has accepted the runbook (evidence: no reconciliation owner named)
- Condition 5 — Separate authorization for the controlled test-site commit: **BLOCKED** — the controlled test-site commit requires its own separate authorization; none was supplied and none can be inferred from this preflight (evidence: no commit authorization supplied)

## Overall: NO-GO
NO-GO: at least one condition is unmet or a blocker stands. This report never issues GO; even a fully green preflight yields at most READY_FOR_HUMAN_REVIEW.
