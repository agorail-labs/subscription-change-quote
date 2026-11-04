# G-17 follow-up: source audit of Chargebee Cashier quantity helpers

**2026-11-03 — Additional source evidence for Issue #30.**
**Disposition: C (keep existing provider-safe refusal).**
This is an OFFLINE code-path analysis plus a simulator regression. It does
not alter SCQ's live adapter, imply live Chargebee behavior has been tested,
authorize a provider call, or establish Chargebee's unpublished API guarantees.

## Why review a quantity-named SDK helper?

The previous G-17 study correctly separates the documented provider API
behavior of `replace_items_list=false` from an unproven same-item quantity
update. Another plausible lead is Chargebee's maintained Cashier integration,
which documents a public `updateQuantity()` helper. The helper name can look
like a targeted operation even when the implementation is not one.

We inspected the **pinned public source**, not merely documentation:

- [Chargebee Cashier `Subscription.php` at commit `7ab4386b4154eedb62b861e44640adf3605cac73`](https://github.com/chargebee/cashier-chargebee/blob/7ab4386b4154eedb62b861e44640adf3605cac73/src/Subscription.php)
- [Its `updateQuantity()` method, lines 345–375](https://github.com/chargebee/cashier-chargebee/blob/7ab4386b4154eedb62b861e44640adf3605cac73/src/Subscription.php#L345-L375)
- [Its `addPrice()` method, lines 615–632](https://github.com/chargebee/cashier-chargebee/blob/7ab4386b4154eedb62b861e44640adf3605cac73/src/Subscription.php#L615-L632)
- [Its `updateChargebeeSubscriptionItem()`, lines 983–1009](https://github.com/chargebee/cashier-chargebee/blob/7ab4386b4154eedb62b861e44640adf3605cac73/src/Subscription.php#L983-L1009)
- [Chargebee `update_for_items` API documentation](https://apidocs.chargebee.com/docs/api/subscriptions/update-subscription-for-items)

Source-code conclusions apply to **that particular upstream commit**; they
cannot establish every version, tenant configuration, or runtime behavior.

## Findings

| Helper and action | Verified helper source shape | What it establishes | What it does NOT establish |
| --- | --- | --- | --- |
| `updateQuantity(quantity, price)` | Reads the provider subscription's complete item list, edits one existing item's quantity in the copied list, passes `replace_items_list=true` and the full list to `updateForItems` | **Source-backed full-replacement request**, not an atomic quantity-only endpoint | Preservation of a third-party item or independent quantity change between GET and POST |
| `incrementQuantity`, `decrementQuantity` | Compute a new target, delegate to `updateQuantity` | They inherit its read/replace path | Concurrency-safe increments, compare-and-swap |
| `updateChargebeeSubscriptionItem` | Reads the full list, patches one item in the array, calls `updateForItems` with `replace_items_list=true` | Another quantity/item helper using replacement | Target-field write atomicity |
| `addPrice` | Sends only one new item through `updateForItems`, without setting the replacement flag by default | Distinct additive wire shape; aligns with the documented add-item behavior | Same-ID existing-item quantity semantics, full schedule/financial preservation, or an **in-schema SCQ** add-item action |
| `removePrice` / swap helper | Full-item-set reconstruction with `replace_items_list=true` | Read/replace behavior persists in removal/swap paths | Preservation of an independent write during the race |

**Critical distinction:** upstream library source is evidence of its request
construction. The Chargebee API documentation explains the replacement mode's
effect. A test against SCQ's mock demonstrates a possible race; it is
**not** a live Chargebee observation. In particular, a method named
`updateQuantity` is not a provider-enforced quantity-only transaction.

## Adversarial reproduction

New isolated `reference/tests/test66-g17-cashier-helper-shape.test.ts`
models the relevant request shapes using SCQ's existing
`G17MockChargebee`, with zero network access and no external PHP execution.

- **66.1**: read full item list; independent add-on arrives; modeled
  quantity-update replacement deletes the newly added item.
- **66.2**: an independent same-item quantity edit between the read and
  replacement is overwritten; the final item set is indistinguishable from
  the clean run.
- **66.3**: a scheduled change created after the read disappears in the
  Ramps-disabled mock. A matching millisecond `resource_version`
  cannot exclude the intervening change.
- **66.4**: an `addPrice`-shaped additive call preserves the other add-on
  in the mocked *item subset*, but still destroys the scheduled change.
  It does not establish an in-scope SCQ operation or overall preservation.

These are **modeled negative controls**, not new discoveries of provider
behavior. They complement rather than replace test57's broader adversarial
matrix; test57 already covers these categories against raw
`update_for_items` wire shapes. Test66 adds an independently sourced SDK
call-path to explain why an apparently narrower helper is not a solution.

## Effect on Issue #30's decision

**No change to the current decision C.** The live Chargebee adapter must
continue to advertise `FULL_REPLACEMENT_ONLY` and refuse
`OPERATION`-authorized updates before dispatch. There is no evidence in
this source audit for a safe `CHANGE_QUANTITY`, `CHANGE_PLAN`,
`CHANGE_CADENCE`, or `CANCEL` dispatch mechanism.

- **A (targeted update): not established for an in-scope SCQ action.**
  The Cashier helper is not proof. The provider's additive semantics for
  adding a *new* addon are relevant but the SCQ action schema does not
  contain `ADD_ADDON`; existing-item same-ID quantity behavior remains
  unconfirmed.
- **B (conditional write): not established.** The inspected Cashier path
  does not pass an expected `resource_version` or equivalent precondition;
  its read then full replacement does not close the write race.
  This does not prove that *no other* Chargebee API has such a feature.
- **C (full replacement + refusal): retain.** Correct safety posture.
- **D (explicit target replacement authorization): still a separate
  normative decision (G-14), not a default fallback.**

The source audit further supports the vendor-facing question: **Is there any
Chargebee-supported operation that atomically changes one existing
subscription item's absolute quantity without replacing unrelated items,
and with protection against concurrent third-party changes and scheduled
state? If so, provide exact endpoint, expected-version/condition parameters,
site prerequisites, and guarantee scope.** This is more precise than
asking whether SDK helper names exist.

Existing vendor questions Q1–Q8 in
[`G17-AUTHORIZATION-PRESERVING-PROTOTYPE.md`](G17-AUTHORIZATION-PRESERVING-PROTOTYPE.md#8-remaining-unknowns-risks-and-the-vendor-clarification-request)
remain unanswered; no contact has been sent on this evidence alone.

## Evidence/progress gates

1. Obtain vendor answers in writing about same-ID quantities, preconditions,
   scheduling and side effects; preserve exact references.
2. If the answer is promising, carry out **separately authorized, read-only**
   synthetic test-tenant retrieval/estimation under Issue #12. A read-only
   pilot does **not** close the TOCTOU window.
3. Require independent provider-side evidence of a preservation-capable
   dispatch before changing the adapter capability or enabling any
   mutation.
4. Keep G-17 OPEN and controlled Chargebee live commit NO-GO until
   those gates actually pass.

**No production/API credentials, live mutations, SCQ frozen spec changes,
npm publication, or MSE changes are part of this audit.**
