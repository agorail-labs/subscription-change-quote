# Recovery-Procedure Audit — is "100 → 120 → 100" a COMPLETE recovery?

Phase 2A, Task 4. Method: re-read the current official documentation at
apidocs.chargebee.com on 2026-10-27 (update-for-items page read in full;
remove-scheduled-changes, ramps, and unbilled-charges docs via search +
page reads), and compared the documented behavior against the recovery
procedure proposed in TEST-RESULTS.md ("Approval needed", step 2) in
Phase 1:

> **Procedure under audit (P):** after the forward commit (100 → 120 seats,
> IMMEDIATE, `replace_items_list=true`, `prorate=true`,
> `invoice_immediately=false`, native idempotency key `scq-<quoteId>`),
> "immediately issue a second, separately-approved update back to 100
> seats with `invoice_immediately=false`, void/delete the resulting
> unbilled charges in the test console if they were not invoiced, and
> confirm via GET that quantity and `has_scheduled_changes` are back to
> their original values. The test site itself is disposable."

## Verdict: NOT COMPLETE

(P) restores the seat quantity under favorable conditions, but it does not
restore — and in several cases cannot even detect — the full pre-experiment
state. Each gap below is documented behavior, not speculation. (P) remains
usable ONLY as a quantity-restoration step inside the larger procedure in
§"Corrected recovery plan" at the end of this document, on a disposable
test site, with every additional check executed. On any site whose state
matters, (P) as written must not be described as a recovery or rollback.

## Findings

### R-1 — The downgrade does NOT remove the forward period's unbilled charges

The forward commit with `invoice_immediately=false` creates prorated
unbilled charges for the 120-seat period. A second update back to 100 is
just another subscription change: nothing in the documented update
behavior deletes pre-existing unbilled charges created by an earlier
change. (The documented cases where unbilled charges ARE deleted are
different operations: backdating a change deletes unbilled charges raised
in the backdated window — with one-time charges explicitly excepted — and
cancellation handling can be configured to delete them.) Unbilled charges
that are left in place are **invoiced automatically at the next
subscription renewal**. (P)'s "void/delete the resulting unbilled charges
in the test console if they were not invoiced" understates this in three
ways:

1. The charges to remove are not only "the resulting" ones from the
   downgrade — they include the FORWARD change's charges, and the
   downgrade itself creates its own prorated credits/charges whose net
   against the forward charges is not guaranteed to be zero (see R-5).
2. Deletion is a per-charge operation (there is a dedicated Delete
   unbilled charge API; console deletion is manual). (P) names no
   enumeration step (list unbilled charges before AND after), so a
   missed charge is invisible until renewal invoices it.
3. If any charge has already been invoiced (see R-4), deletion is
   impossible — remediation becomes credit notes / refunds, which are
   outside both (P) and SCQ's scope.

### R-2 — Scheduled changes deleted by the forward update are NOT restored

Documented product behavior: any existing scheduled change is overridden
when a new change is scheduled, and applying changes to a subscription
removes its previously scheduled changes — Chargebee's own guidance for
the specific-date flow is to first capture the scheduled change (retrieve
with scheduled changes, or webhook event contents) precisely because the
update discards it. The behavior is broader than scheduling: a support
documented case shows even a metadata-only subscription change removing
a scheduled cancellation. There is **no `replace_scheduled_changes`
parameter on `update_for_items`** in the current documented parameter
list (read in full for this audit) that would let the forward update
preserve them, and the reverse update has no restore semantics either.

Consequences for (P):

- If the test subscription had ANY pre-existing scheduled change (a
  scheduled quantity/plan change, a scheduled cancellation, or a ramp —
  in Ramps compatibility mode `has_scheduled_changes` reflects ramps),
  the forward commit can silently destroy it and (P) never brings it
  back. (P)'s final check ("`has_scheduled_changes` back to its original
  value") would actually FAIL in that case (true → false) — but only if
  the original value was true and someone recorded it; (P) records no
  pre-state snapshot at all.
- Removing a scheduled change that had advance invoices generates
  **credit notes** against those invoices (documented on the
  remove-scheduled-changes API). Those credit notes are real financial
  artifacts the recovery does not enumerate or unwind.
- Restoration, when needed, is a separate re-creation step: re-apply the
  captured scheduled change (deprecated update path) or re-create the
  ramp (Ramps API, Early Access, with its own constraints — e.g.
  remove-scheduled-changes errors when multiple ramps exist).

For the synthetic Phase 1 fixture the subscription is created fresh with
no scheduled changes, which is the ONLY reason this gap is dormant there.
(P) does not state that precondition.

### R-3 — Mandatory addons: `replace_items_list=true` does not guarantee the item set

Documented on the update page:

- With a plan in `subscription_items` and `replace_items_list=true`, the
  entire item list (plan and addons) is replaced by the provided list.
- With an addons-only list, the plan is always retained, and with
  `replace_items_list=true` existing addons are replaced EXCEPT mandatory
  addons (auto-attached to the plan), which are kept unless listed in
  `mandatory_items_to_remove`.
- A site setting ("Remove mandatory addons from old plan during
  subscription plan update") further changes what happens to the old
  plan's mandatory addons on a plan change.

The live adapter sends a full plan-inclusive list and no
`mandatory_items_to_remove`. For the quantity-only synthetic case (same
plan) the practical risk is low, but (P) verifies only the seat quantity
and `has_scheduled_changes` — it never compares the full item list
(including mandatory addons auto-attached to the plan) before/after, so
an addon discrepancy would pass its checks undetected. Any plan-changing
variant of the experiment inherits the full mandatory-addon surface.

### R-4 — Invoice timing: the recovery window closes at renewal (and at any invoicing event)

With `invoice_immediately=false`, charges sit as unbilled charges ONLY
until something invoices them: automatic invoicing at the next renewal,
an explicit create-invoice-for-unbilled-charges call, or site automation.
If the term renews between the forward commit and the recovery — or the
experiment straddles a renewal for any other reason — the forward
period's charges become a real invoice (with a payment attempt when
auto-collection is on). At that point (P)'s delete step is void and the
"recovery" needs credit notes/refunds and a payment reversal story that
neither (P) nor SCQ provides. (P) says "immediately", which mitigates but
does not bound this: it names no check that `next_billing_at` /
`current_term_end` is comfortably in the future before starting, and no
abort condition if an invoice appears mid-procedure. Scheduled advance
invoices (`has_scheduled_advance_invoices`) are a second timing surface:
an update interacting with advance-invoiced terms can produce credit
notes (see R-2) that (P) never looks for.

### R-5 — The reverse proration is not symmetric: net-zero is not guaranteed

Proration is computed against the fraction of the term remaining AT THE
TIME OF EACH CALL. The forward charge (at t1) and the reverse credit (at
t2 > t1) are computed over different remaining fractions, so even with
identical `prorate=true` on both calls the two amounts need not cancel —
a residual charge or credit is the expected outcome, growing with the
gap between the calls. (P) implicitly assumes the pair nets out; it
includes no residual-balance check. Related documented interaction
(audit A9): if a previous in-term change had `prorate=false`, a later
`prorate=true` change creates no credits — not triggered by (P)'s
parameters (both calls prorate), but any intervening change with
different parameters re-opens it.

### R-6 — Term state is not verified

A quantity-only change on the same item price should not reset the term
(`force_term_reset` defaults to false; automatic reset is documented for
billing-period changes). But "should not" is not a check: (P) never
compares `current_term_start`, `current_term_end`, or `next_billing_at`
before/after. Any term reset — from an intervening change, a site
configuration, or a future plan-changing variant — would silently move
the billing anchor and change what "recovered" even means.

### R-7 — Balances, coupons, and discounts are outside (P)'s field of view

Estimates and updates interact with customer balances
(`use_existing_balances` defaults to true: promotional/refundable
credits and excess payments are folded in), coupons (the update's
`replace_coupon_list` defaults to false — additive), and discounts. A
forward/reverse pair can consume balances or leave coupon state altered
in ways a quantity check cannot see. The synthetic fixture has none of
these, but (P) does not state that precondition or verify it.

### R-8 — The recovery commit itself has the same lost-response / idempotency limits

The reverse update is a new SCQ quote with a new native idempotency key.
If its response is lost, the same rules apply (reconcile by re-reading;
never blindly re-issue), and the native window is still only 30 minutes.
SCQ receipt replay for the recovery quote depends on the same volatile
in-memory QuoteStore (LIMITATIONS D-3). (P) does not mention any of
this; an operator following (P) literally could double-apply the
downgrade after a timeout.

### R-9 — Fields that take effect immediately regardless of scheduling

On the update operation, `auto_collection`, `shipping_address`,
`po_number`, and subscription-level custom fields always take effect
immediately regardless of `change_option`. Neither adapter sends them,
so this is dormant for the current experiment — but any recovery variant
that piggybacks such fields onto either update would partially apply
immediately, and (P)'s state comparison would not catch it because it
never snapshots those fields.

## Corrected recovery plan (replaces (P) for any future approved live run)

Preconditions to verify BEFORE the forward commit (abort if any fails):

1. Synthetic test site, disposable; no real payment method (test gateway).
2. Fresh subscription created for the experiment: quantity 100, single
   plan item, NO addons (mandatory or otherwise), NO coupons/discounts,
   NO customer balances, NO contract term.
3. `has_scheduled_changes=false` AND `has_scheduled_advance_invoices=false`,
   confirmed by GET; additionally capture the full pre-state: complete
   item list, `current_term_start/end`, `next_billing_at`, status, and an
   (expected empty) list of unbilled charges and ramps.
4. `next_billing_at` is far enough in the future that forward + recovery
   complete well inside the current term (R-4).

Recovery steps (each separately approved, in order):

5. Reverse update to the ORIGINAL full item list (not just the seat
   quantity) with `invoice_immediately=false`, `prorate=true`,
   `replace_items_list=true`, under a NEW quote/idempotency key; on a
   lost response, reconcile by re-reading before any further call (R-8).
6. List unbilled charges; delete EACH unbilled charge created by either
   update individually (Delete unbilled charge API or console); verify
   the unbilled-charge list is empty afterwards — do not assume the pair
   netted to zero (R-1, R-5). Any residual prorated credit/charge that
   cannot be deleted must be recorded as a known leftover, not silently
   absorbed.
7. Verify by GET: full item list equals the pre-state item-for-item,
   `current_term_start/end` and `next_billing_at` unchanged (R-6),
   `has_scheduled_changes` and `has_scheduled_advance_invoices` back to
   false, status unchanged.
8. Check for side-effect artifacts created during the pair: invoices
   (must be none), credit notes (must be none on the fresh fixture).
   If an invoice exists, STOP: recovery from that point is
   credit-note/refund territory, outside this plan and outside SCQ.
9. If step 3's preconditions could not be met (pre-existing scheduled
   changes/ramps/addons/balances): the pair is NOT a recovery. Either
   capture and re-create the scheduled changes/ramps explicitly and
   verify them, or discard the site wholesale — on a disposable test
   site, wholesale discard remains the only unconditionally complete
   "recovery", which is what (P)'s last sentence gestures at without
   stating that it is load-bearing.

## Sources (official, re-read 2026-10-27)

- Update a subscription (full parameter list: `replace_items_list`,
  `mandatory_items_to_remove`, `end_of_term` deprecated, `change_option`,
  `changes_scheduled_at` deprecated for scheduling, `invoice_immediately`,
  prorate caveat, immediate-effect fields):
  https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items
- Remove scheduled changes (exactly-one constraint; credit notes against
  advance invoices): https://apidocs.chargebee.com/docs/api/subscriptions/remove-scheduled-changes
- Scheduled-change override behavior (product docs: "Any scheduled change
  will be overridden if a new change is scheduled"; capture-before-update
  guidance; metadata-change removal case): chargebee.com/docs
  subscriptions documentation, retrieved 2026-10-27.
- Unbilled charges (auto-invoiced at next renewal; delete is a dedicated
  operation; backdating/cancellation deletion cases):
  https://www.chargebee.com/docs/billing/2.0/subscriptions/unbilled-charges
- Ramps (Early Access; `effective_from` is Create-a-ramp's parameter):
  https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp
