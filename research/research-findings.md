# SCQ Research Findings — Stripe/Paddle/Zuora/Chargebee Subscription-Change Normalization

> **Read order**: this file now covers eight research cycles (v0.1–v0.6.1,
> plus v0.5-LIVE between v0.5 and v0.6), appended in order. Earlier
> sections are left unedited except where explicitly superseded. **The
> v0.6.1 section at the very end is current** — it is a standards-hardening
> pass over the v0.6 protocol freeze candidate: narrower EXACT wording,
> clarified REVALIDATE/BEST_EFFORT semantics with required post-commit
> reconciliation, explicit quote-expiration and commit-idempotency rules,
> and several conformance-suite gaps closed. No providers, actions, or
> major schema concepts were added. If you only have time for one section,
> read v0.6.1. See `scq-v0.6.1-spec.md` (normative spec, renamed from
> `scq-v0.6-spec.md`) and `conformance.md` (test-suite-to-rule mapping),
> both updated this cycle.

## Summary and method

This prototype implements a normalized "Subscription Change Quote" (SCQ) abstraction — a
`quote → commit` lifecycle for subscription changes (seat quantity, plan, cadence, cancellation)
— against two provider simulators built to mimic Stripe's and Paddle Billing's real,
documented subscription-update/preview APIs.

**No live Stripe or Paddle API keys are available in this sandbox.** The simulators
(`src/adapters/stripe-sim.ts`, `src/adapters/paddle-sim.ts`) are in-memory fakes grounded in
documented API shapes and mechanisms as of this writing:

- Stripe: `subscriptions.update` with `items[]` and `proration_behavior`
  (`create_prorations` / `none` / `always_invoice`), the "upcoming invoice" preview concept,
  `subscription.items[].id`, `current_period_end`, `latest_invoice`.
- Paddle Billing: `subscriptions/{id}/preview` (dry-run of an update), `proration_billing_mode`
  values (`prorated_immediately`, `prorated_next_billing_period`, `full_immediately`,
  `full_next_billing_period`, `do_not_bill`), `billing_cycle`, `current_billing_period`,
  cancellation via `effective_from: immediately | next_billing_period`.

Where we were **not confident** a specific mechanism is exactly right (rather than a
reasonable inference from documented shapes), that uncertainty is flagged explicitly inline
in code comments and again below — most importantly around whether either provider exposes
*any* field usable as an optimistic-concurrency token. We did not have live-docs access to
verify this with certainty; we are reasoning from the fields we're aware are publicly
documented on each provider's subscription resource, none of which read as a version/etag.

The research method: build the simulators to reproduce known limitations rather than paper
over them, then write 6 test scenarios that probe exactly the boundaries SCQ v0.1 needs to
work — mutation isolation, deferred timing, cross-provider field gaps, cancellation
semantics, staleness detection, and proration drift — and record what actually happened.

All 13 tests (6 scenarios × 2 providers, plus one supplementary drift-magnitude test) pass.
"Pass" for Tests 2, 3, and 6 specifically means: the test successfully **demonstrates and
asserts the existence of a real limitation**, not that everything worked cleanly. Full test
output is in the repo; see `README.md` for how to re-run.

---

## Capability table

| Capability | Stripe | Paddle | SCQ implication |
|---|---|---|---|
| **Stable subscription version** | **IMPOSSIBLE_TO_GUARANTEE (native).** No version/etag field on the subscription object. Only mutable-field state (items, status, `current_period_end`, `cancel_at_period_end`) exists to compare against. | **IMPOSSIBLE_TO_GUARANTEE (native), same reasoning.** No confirmed version/etag field on the subscription resource either (uncertainty noted — not independently verified against live docs). | **SCQ_LAYER_CAN_ADD**: both adapters compute a SHA-256 content hash over mutable fields as a synthetic fingerprint (`StripeSim.fingerprint`, `PaddleSim.fingerprint`). This is a workaround, not a guarantee — see "version/fingerprint problem" below. |
| **Non-mutating preview** | **NATIVE.** "Upcoming invoice" preview computes proration/amounts without mutating. | **NATIVE.** Documented `subscriptions/{id}/preview` endpoint is explicitly non-mutating. | Both providers support this natively; SCQ's `createChangeQuote` maps directly onto it. |
| **Preview identifier** | **DERIVABLE, not native.** Stripe's upcoming-invoice preview has no durable server-side id you can hand back later — it's a computed response, not a stored resource. | **DERIVABLE, not native**, same shape — Paddle's preview response is also a computed object, not a persisted, independently-addressable resource (to our knowledge). | **SCQ_LAYER_CAN_ADD**: `quote.id` (`scq_stripe_*` / `scq_paddle_*`) is entirely SCQ-side, backed by `QuoteStore`. Neither provider gives you an id to round-trip. |
| **Preview expiry** | **IMPOSSIBLE_TO_GUARANTEE (native).** No TTL/expiry concept on a preview response — it's just a point-in-time computation. | **IMPOSSIBLE_TO_GUARANTEE (native)**, same. | **SCQ_LAYER_CAN_ADD**: `validUntil` / `expires_at` are invented at the SCQ layer (`QUOTE_TTL_MS` = 5 min in this prototype) and enforced by `validateCommit`. |
| **Commit preview directly** | **IMPOSSIBLE.** There is no "commit this exact preview" call. `subscriptions.update` is a fresh mutation that recomputes proration itself; it does not accept a frozen preview result. | **IMPOSSIBLE**, same shape. `PATCH /subscriptions/{id}` recomputes at call time; the preview endpoint and the update endpoint are two independent calls. | This is the central finding of Test 6 (see below). SCQ can *replay the same inputs*, but cannot force the provider to reproduce *the same output*. |
| **Preserve proration calculation** | **IMPOSSIBLE_TO_GUARANTEE.** Proration math is a function of wall-clock time and current period boundaries at the moment `update()` is called, not something frozen into the preview. | **IMPOSSIBLE_TO_GUARANTEE**, same — `prorated_immediately` mode computes the elapsed/remaining fraction at commit time. | Confirmed directly by Test 6b: same inputs, 10 simulated days apart, produced $200.00 vs $133.33 for an identical seat upgrade — despite the SCQ fingerprint being unchanged (fingerprint doesn't hash wall-clock time). |
| **Detect concurrent mutation** | **DERIVABLE**, not native as a single check — you must retrieve current state and diff it yourself; Stripe doesn't offer a compare-and-swap request parameter. | **DERIVABLE**, same — no native optimistic-lock request parameter as far as documented fields show. | **SCQ_LAYER_CAN_ADD**: `validateCommit` re-fingerprints current state and compares to the quote's frozen fingerprint before allowing commit (Test 5). This catches *item/status/period* changes but not *time-only* drift (Test 6). |
| **Expose future recurring amount** | **NATIVE**, via the preview's resulting invoice line total / `next_period_recurring_amount`. | **NATIVE**, via the preview's `next_transaction.amount`. | Both map cleanly onto `commercialEffect.recurring.resultingAmount`. |
| **Expose commitment semantics** | **IMPOSSIBLE_TO_GUARANTEE** for a plain subscription. Stripe subscriptions (outside of a separate, heavier "Subscription Schedule" object we did not model) have no contract-term/lock-in field — only `cancel_at_period_end`, which is not the same thing as a commitment window. | **IMPOSSIBLE_TO_GUARANTEE**, same — Paddle Billing subscriptions likewise expose no distinct contract-term object for a plain price/cadence change. | Test 3 demonstrates this directly: `commercialEffect.term.createsCommitment` and `.commitmentUntil` are left `undefined` for both providers rather than invented. This is a real modeling gap SCQ v0.1 cannot close without a heavier provider object (Stripe Schedules, or whatever Paddle's contract equivalent would be). |
| **Expose cancellation semantics** | **NATIVE.** `cancel_at_period_end` (schedule) vs. immediate `status: canceled` is a first-class, well-documented distinction. | **NATIVE.** `effective_from: immediately | next_billing_period`, surfaced via `scheduledChange` on the resource. | Cleanly normalizable; confirmed by Test 4 for both providers. |

---

## Findings from the 6 test scenarios

### Test 1 — 100→120 seats, IMMEDIATE (both providers)
- Quote computed an immediate proration **charge of $200.00** (`20000` minor units) for the
  20-seat upgrade with ~29/30 of the period remaining, and a resulting recurring amount of
  **$1,200.00/mo** (`120000`).
- Confirmed the quote call performed **zero mutation**: `getSubscription` before and after
  `createChangeQuote` returned identical quantity (100) and identical fingerprint.
- `commitChangeQuote` then mutated the quantity to 120 and returned a `COMMITTED` receipt.
- Both Stripe and Paddle simulators produced numerically identical proration behavior here —
  unsurprising, since both compute a straight time-remaining-fraction proration for immediate
  quantity changes.

### Test 2 — 100→80 seats, NEXT_PERIOD (both providers) — real mechanism gap found
- As expected, `commercialEffect.immediate` was `undefined` and `resultingAmount` reflected
  the new $800.00/mo total, effective at `current_period_end`.
- **The gap**: for both providers, "NEXT_PERIOD" in this prototype only controls *proration/
  billing timing* (no charge levied now), **not the timing of the item mutation itself**.
  Committing the quote calls `subscriptions.update` / `PATCH /subscriptions/{id}` immediately,
  which changes `items[].quantity` right away in both simulators — matching real API behavior:
  - Stripe has no primitive on a plain subscription to defer *applying* an item change to
    period end; that requires a separate, heavier **Subscription Schedule** object, which is
    out of scope for v0.1 and was not modeled here.
  - Paddle's `proration_billing_mode` governs *when money moves*, not *when `items[]`
    changes* — the update call itself is immediate.
  - **This means an SCQ consumer requesting `NEXT_PERIOD` today gets billing-deferral
    semantics but NOT true deferred-application semantics**, on both providers, without
    additional provider-specific scheduling objects SCQ v0.1 does not wrap. This is flagged
    as a real, unresolved gap rather than silently "handled."

### Test 3 — MONTHLY→ANNUAL (both providers) — real field gap found
- Derivable and correctly exposed: new recurring amount ($10,000.00/yr on quantity 100),
  currency, cadence, and effective date.
- Correctly exposed as `undefined` rather than invented: `term.createsCommitment` and
  `term.commitmentUntil`. Neither provider's plain subscription/price object carries a
  distinct contract-term construct we could honestly map this from.
- One implementation bug was caught and fixed during this work: the Paddle simulator
  initially failed to recompute `billingCycle.interval` when a cadence-changing price swap
  was applied (it would report `MONTHLY` after being pushed to an annual price). Real Paddle
  subscriptions do update `billing_cycle` on such a plan change, so the simulator was
  corrected to match — this is now covered by the passing test.

### Test 4 — CANCEL at PERIOD_END (both providers)
- Both providers correctly returned `status: "active"` immediately after commit (the
  subscription is not actually canceled yet) with `term.autoRenew: false`.
- Stripe models this via `cancel_at_period_end: true`; Paddle via a `scheduledChange: {action:
  "cancel", effectiveAt: <period end>}` field. Both normalize cleanly to the same SCQ shape.

### Test 5 — Stale quote (both providers)
- Quote created against fingerprint F1. Subscription then mutated **out-of-band** (directly
  via the sim, bypassing SCQ entirely — modeling e.g. a support-agent dashboard action or a
  webhook-driven change) to quantity 150.
- `commitChangeQuote` correctly threw `SCQError("QUOTE_STALE")` for both providers, and the
  subscription was left at quantity 150 — i.e., **the commit attempt itself performed no
  additional mutation**. This confirms `validateCommit`'s fingerprint check does its job for
  the class of drift it's designed to catch (item/status/period changes).

### Test 6 — Preview drift under proration (both providers) — the central limitation
This is the most important finding of the whole exercise, and it is **not a bug** — it's a
structural property of both real APIs.

- A quote was created for a 100→120 seat immediate upgrade, quoting a **$200.00** proration
  charge (day 0 of a 30-day period).
- Simulated time was then advanced **10 days**, with no other state change. The SCQ
  fingerprint — a hash of items/status/period-boundaries — was **unchanged**, because it
  does not (and structurally cannot, without inventing a synthetic clock-embedding scheme
  outside anything either provider does) hash wall-clock time.
- `commitChangeQuote` therefore proceeded (fingerprint matched → not STALE), returning a
  receipt whose `commercialEffect` was **copied verbatim from the frozen quote** ($200.00).
- Test 6b independently re-ran the *same* preview inputs directly against the simulator at
  day 0 vs. day 10 and confirmed the underlying provider math genuinely differs:
  **$200.00 (day 0) vs. $133.33 (day 10)** for the identical 100→120 seat change, purely
  because less of the billing period remains.
- **In a real integration, this means the SCQ receipt's `commercialEffect` for
  proration-bearing changes is only guaranteed accurate if commit happens essentially
  immediately after quote.** If real elapsed time (not just the fingerprint-checked fields)
  passes between quote and commit, the actual invoice/transaction the provider generates can
  differ from what was quoted — and neither provider gives SCQ a way to force "honor exactly
  this proration number," because proration is recomputed fresh at mutation time on both
  Stripe and Paddle.

---

## The version/fingerprint problem

Neither Stripe nor Paddle subscription objects expose anything we could confidently call a
native optimistic-concurrency token:

- **Stripe**: No `version`, `etag`, or monotonic counter field on the `Subscription` object.
  The only "this changed" signal Stripe surfaces is the event/webhook stream
  (`customer.subscription.updated`), which is a notification mechanism, not a
  compare-and-swap primitive you can send back on a subsequent write.
- **Paddle**: To our knowledge (not independently verified against live docs in this
  sandbox — flagged explicitly as uncertain), Paddle Billing's subscription resource
  similarly lacks a dedicated version/etag field among its documented properties.

**SCQ's workaround**: both simulators compute a SHA-256 hash over a canonical JSON
projection of the fields that matter for correctness — `items` (price/quantity), `status`,
period boundaries, and any pending scheduled change. `validateCommit` re-fingerprints the
live subscription at commit time and rejects with `QUOTE_STALE` on any mismatch, performing
no mutation.

**Limitations of this workaround**, all of which are real and unresolved:

1. **Race window.** Fingerprinting happens as a separate read before the mutating call; a
   concurrent write between that read and the mutation could still slip through in a fully
   concurrent system (this prototype is single-threaded/in-memory so it can't manifest here,
   but it is a real design constraint worth flagging for any production version — real
   compare-and-swap needs an atomic read-check-write, which neither provider exposes at the
   API layer, so any implementation must accept this window or add its own locking).
2. **Fields the hash doesn't (and structurally can't) cover.** Wall-clock time is the
   headline example (Test 6): proration math depends on "now" and period boundaries, and
   "now" isn't a property of the subscription object, so it can't be hashed as part of it —
   yet it materially changes the financial outcome.
3. **Server-side recalculation the hash can't see coming.** Tax and discount/coupon
   recalculation are the other classic examples: if a provider recomputes tax or applies a
   coupon at invoice-generation time based on state that lives outside the subscription
   object proper (e.g. customer tax location, a coupon's own expiry), the fingerprint has no
   way to detect that risk in advance, because those inputs were never part of what got
   hashed. This prototype's simulators do not model tax/discount objects at all, so this
   risk is described here as an extrapolation from the same root cause Test 6 demonstrates,
   not something we directly reproduced in code.

---

## Test 6 / preview drift, explained in provider terms

"Commit the exact quoted change" is fundamentally **best-effort, not guaranteed**, for any
proration-bearing change, on both providers, because of how each actually computes the
number:

- **Stripe**: the "upcoming invoice" preview and the `subscriptions.update` mutation are two
  independent API calls. Proration line items are computed by Stripe **at the moment each
  call is made**, using the then-current `current_period_start`/`current_period_end` and
  wall-clock time to derive the remaining-time fraction. There is no parameter on
  `subscriptions.update` that says "use the proration I already computed in this specific
  earlier preview call" — it recomputes from scratch every time.
- **Paddle**: the `subscriptions/{id}/preview` and `PATCH /subscriptions/{id}` calls have the
  same relationship. `proration_billing_mode: prorated_immediately` tells Paddle *how* to
  prorate (by remaining-time fraction) but the fraction itself is derived from
  `current_billing_period` and current time at the moment of the actual update call, not
  frozen from the preview.

The practical consequence for SCQ: the quote's `commercialEffect` is an accurate **estimate
at quote time**, and the fingerprint check protects against a large class of drift (item,
status, and period changes), but it cannot protect against **pure time-elapsed drift** for
proration math, because time isn't a mutable field of the subscription to hash in the first
place. Any production SCQ layer should either (a) enforce a very short quote TTL for
proration-bearing proposals specifically, (b) re-preview immediately before commit and
surface a "numbers changed, please reconfirm" flow instead of silently committing stale
numbers, or (c) accept and clearly disclose that quoted proration is indicative, not binding,
until the receipt is returned.

---

## Recommendation: **MODIFY**

The core `quote → commit` shape genuinely works, and both providers support the essential
pieces natively: non-mutating previews, computable future recurring amounts, and clean
cancellation semantics all map cleanly onto SCQ v0.1's normalized model (Tests 1, 4, and the
"native" rows of the capability table confirm this). That's a real, usable abstraction layer,
not nothing.

But three findings mean SCQ v0.1 as specified cannot be shipped as-is without either scoping
changes or additional disclosure to callers:

1. **Preview identifiers, expiry, and staleness detection are entirely invented by the SCQ
   layer** — neither provider gives you a real quote object to hold onto. That's fine as a
   design choice, but it means SCQ's guarantees ("this quote is valid until X", "this quote
   is still current") are only as strong as the SCQ layer's own bookkeeping and fingerprint
   scheme, not backed by any provider-side guarantee.
2. **NEXT_PERIOD effective-policy changes do not actually defer application** on either
   provider without wrapping a heavier scheduling object (Stripe Subscription Schedules; the
   Paddle equivalent, if one exists, was not modeled here) — this is a functional gap between
   what the API surface promises (`effectivePolicy: "NEXT_PERIOD"`) and what v0.1's adapters
   can actually deliver.
3. **Proration-bearing commits are inherently best-effort**, not guaranteed to match the
   quoted number, once any real time elapses between quote and commit — and the fingerprint-
   based staleness check cannot catch this class of drift at all, by construction.

None of these are fatal to the concept — they're solvable with scope changes: (a) explicitly
document quoted proration as indicative and either enforce very short TTLs or re-preview
before commit for those proposal types, (b) either drop NEXT_PERIOD from v0.1's guaranteed
semantics or invest in wrapping the heavier scheduling primitives per provider, and (c) keep
being explicit (as this prototype is) about which commercial-effect fields are
provider-derivable vs. structurally unknowable, rather than quietly defaulting them. With
those adjustments, SCQ is a sound abstraction. Shipped as originally specified, with
NEXT_PERIOD and proration guarantees implied at face value, it would overpromise what either
provider can actually deliver.

---
---

# SCQ v0.2 Research Findings

**Research question for this cycle**: does SCQ provide meaningful interoperability semantics
beyond wrapping existing subscription preview APIs — specifically via (1) explicit quote
guarantee strength, (2) agent-approved commercial acceptance envelopes, and (3) atomic
quote/precondition commit?

Scope actually implemented this cycle, matching the task exactly: Stripe `proration_date`
replay; `guaranteeMode: EXACT | REVALIDATE`; `acceptanceEnvelope` for REVALIDATE;
`QUOTE_DRIFTED` error; explicit `"UNKNOWN"` sentinel replacing `undefined` for genuinely
unknowable provider fields; removal of `NEXT_PERIOD` from CHANGE_* proposals; a TOCTOU test;
and a determination of provider-side atomic precondition+mutation support. No new providers,
no payments, no authorization, no negotiation, no usage billing were added.

All test numbers below are from actual runs of `npm test` in this repo (16/16 passing —
`node --test` output captured verbatim, not hand-computed).

## What changed and why

- **`proration_date` (Stripe only)**: real, documented Stripe parameter on
  `subscriptions.update` (and the upcoming-invoice preview) that pins the remaining-time
  fraction to a caller-supplied timestamp instead of "now". `createChangeQuote` captures
  `proration_date = <the moment the preview was computed>`; EXACT-mode `commitChangeQuote`
  replays it verbatim. `stripe-sim.ts` also models the real rejection case: a `proration_date`
  that has rolled outside the current billing period is refused (`invalid_request_error`),
  matching documented Stripe behavior.
- **No Paddle equivalent added.** `paddle-sim.ts` was deliberately NOT given a
  `prorationDate`-style parameter. We are not aware of a documented Paddle Billing parameter
  that lets a caller pin the elapsed/remaining-time fraction used by `prorated_immediately` to
  an arbitrary earlier timestamp. Inventing one would misrepresent Paddle's real surface — the
  entire point of this exercise is to not paper over asymmetries between providers. This is
  flagged as an important, uncertainty-noted finding (we could not verify absence against live
  docs in this sandbox; we are reasoning from the mode/parameter set we're aware Paddle
  documents), not asserted with total confidence.
- **`guaranteeMode: "EXACT" | "REVALIDATE"`** — part of the type on every proposal, CANCEL
  included (it's a field on the whole proposal, not a per-action addition). In practice
  neither adapter varies CANCEL's behavior by guarantee mode, because cancellation carries no
  proration line in either sim — there is nothing for REVALIDATE to usefully re-check.
  - **EXACT**: "commit will reproduce the quoted `commercialEffect`, or refuse." Implemented on
    Stripe via `proration_date` replay. On Paddle there is no equivalent mechanism to implement
    it with, so EXACT silently degrades to "best-effort," identical to v0.1's unguarded
    behavior. This asymmetry is the headline finding of this cycle (see below).
  - **REVALIDATE**: re-derive commercial effect from a fresh, non-mutating preview call against
    *live* state immediately before the mutating call, compare it to the quote within an
    explicit `acceptanceEnvelope`, and refuse with `QUOTE_DRIFTED` (no mutation) if it falls
    outside. Implemented identically in both adapters (`stripe-adapter.ts`,
    `paddle-adapter.ts`) — this is the one guarantee mode that is genuinely symmetric across
    providers, because both preview endpoints are non-mutating and callable on demand.
- **`acceptanceEnvelope`**: `{ maxImmediateNetIncrease?, maxImmediateCreditDecrease?,
  maxRecurringIncrease? }`, minor units. Unstated bounds default to **zero tolerance** in that
  dimension — a caller must opt into slack explicitly (`scq-engine.ts`
  `checkAcceptanceEnvelope`). This was a deliberate design choice matching the task's framing
  of "agent-approved" envelopes: SCQ should never invent tolerance on the agent's behalf.
- **`QUOTE_DRIFTED`**: thrown only by REVALIDATE, only before any mutation occurs (see ordering
  note below). EXACT mode never returns it — for EXACT, the contract is "reproduce exactly or
  the underlying call itself fails/refuses," not "recompute and compare."
- **`"UNKNOWN"` sentinel**: `term.commitmentUntil` / `term.createsCommitment` now return the
  literal string `"UNKNOWN"` instead of `undefined` wherever v0.1 left them undefined for the
  same reason (no contract-term object on a plain subscription, either provider). This is a
  documentation-fidelity fix, not a new finding — v0.1's `undefined` was ambiguous between
  "not asked" and "provider structurally cannot say," and `"UNKNOWN"` disambiguates it.
- **`NEXT_PERIOD` removed** from `CHANGE_QUANTITY` / `CHANGE_PLAN` / `CHANGE_CADENCE`. v0.1's
  Test 2 found this effective-policy value implied a deferred-*application* guarantee neither
  provider's plain subscription object can deliver without a heavier scheduling primitive
  (Stripe Subscription Schedules; no confirmed Paddle equivalent). Rather than keep
  documenting the gap indefinitely, v0.2 removes the value from the type so the schema itself
  no longer promises something the adapters cannot do. `CANCEL`'s `PERIOD_END` is unaffected
  and stays — it's a different, genuinely native primitive on both providers (v0.1 Test 4).

## Test results (v0.2 additions)

### Test 6, re-run (EXACT mode) — Stripe: fixed. Paddle: not fixable.
- **Stripe**: quoted a **$200.00** immediate charge (100→120 seats) at day 0. Advanced
  simulated time 10 days. An *unpinned* re-preview at day 10 would have charged **$133.33** —
  confirmed independently via `sim.previewUpcomingInvoice()` with no `proration_date`. But the
  actual `commitChangeQuote()` call, which replays the captured `proration_date`, produced
  **exactly $200.00** — matching the quote. This is a genuine fix, not a re-assertion of the
  frozen number: the assertion is against the *sim's own re-preview*, i.e. against what the
  provider would otherwise have charged, and the pinned mutation provably diverges from that
  unpinned path.
- **Paddle**: same setup, same $200.00 quote, same 10-day gap. EXACT mode on Paddle has no
  parameter to pin the time basis, so the underlying `prorated_immediately` math at commit time
  is unavoidably computed against current state — confirmed to differ from the quoted number
  via a live re-preview taken immediately after commit. **EXACT mode on Paddle is not
  meaningfully different from v0.1's unguarded commit.** SCQ's `guaranteeMode: "EXACT"` field
  can be set on a Paddle proposal, but nothing in the adapter or the provider can make that
  guarantee true for proration-bearing changes. This is reported here rather than hidden:
  the adapter does not throw or warn when EXACT is requested against Paddle for a
  proration-bearing action, which is itself worth calling out as something a production
  SCQ layer should probably do (reject `guaranteeMode: EXACT` up front for providers/actions
  where it cannot be honored, rather than silently downgrading to best-effort).

### Test 6c/6d — REVALIDATE mode: works symmetrically, with real trade-offs
- **Paddle, REVALIDATE, zero-tolerance envelope**: same 10-day-gap setup. The re-preview
  immediately before mutation detected the drift and the commit was refused with
  `QUOTE_DRIFTED` — **and the subscription was confirmed unmutated** (quantity remained 100).
  This is the "refuse safely" outcome the task calls for, and it is the *only* mechanism this
  research found that gives Paddle any commit-time integrity guarantee at all for
  proration-bearing changes.
- **Stripe, REVALIDATE, generous envelope**: re-preview at day 10 produced $133.33 (inside the
  envelope), so the commit proceeded — but note carefully what it committed: **the revalidated
  $133.33 figure, not the originally quoted $200.00.** `receipt.commercialEffect` still reports
  the original quote (kept for audit-trail purposes — "this is what the agent saw and
  approved"), while the new `receipt.revalidatedEffect` field carries what was actually
  re-derived and used to gate/execute the commit. **These two numbers can legitimately differ
  by design under REVALIDATE** — that is the entire point of the mode, but it means a caller
  reading only `commercialEffect` from a REVALIDATE receipt would see a number that is NOT what
  was actually charged. Any consumer of REVALIDATE receipts must read `revalidatedEffect`, not
  `commercialEffect`, to know the true outcome.

### Test 7 — TOCTOU: real, confirmed, present on both providers, structurally unfixable at the SCQ layer
- Both adapters' `commitChangeQuote` perform a **read+fingerprint** call, then (for
  REVALIDATE) a **re-preview** call, then a separate **mutate** call. A monkey-patched
  `sim.update()` was used to inject an out-of-band write (quantity → 999) timed to land
  *after* `validateCommit`'s fingerprint check passed but *before* the mutating call executed —
  i.e. exactly inside the real race window, without adding any synchronization construct of our
  own.
- **Result on both providers**: the fingerprint check had already passed (it ran before the
  injected write), so no `QUOTE_STALE` was raised. SCQ's own mutation then proceeded
  unconditionally and overwrote the concurrent write, landing at quantity **120** (the quoted
  target) — the concurrent actor's write to 999 was silently destroyed with no error, no
  conflict signal, to either party.
- This is arguably a worse outcome than a detected conflict: a lost-update is not merely
  "possibly stale," it is **irrecoverably gone** with no trace it ever happened, from either
  SCQ's or the concurrent actor's point of view.
- **Test 7c** is a standing regression guard: it reads the actual adapter source files at test
  time and asserts they contain no mutex/lock/semaphore construct, so this finding cannot be
  quietly invalidated later by someone adding exactly the kind of client-side synchronization
  the research task said not to add.

## Does either provider support atomic state-precondition + mutation?

**No — on neither Stripe nor Paddle, as far as their documented, mainstream subscription
update surfaces go**, with the following reasoning and explicit uncertainty:

- Neither `subscriptions.update` (Stripe) nor `PATCH /subscriptions/{id}` (Paddle) accepts
  anything resembling an HTTP conditional-request precondition (`If-Match` / ETag-style) that
  the **server** would enforce atomically against the same request's mutation. Both are
  fire-and-mutate calls: the server reads its own current state, applies the change, and
  responds — there is no parameter that says "only apply this if the resource's version/hash
  still equals X."
- Consequently, **any** compare-and-swap SCQ attempts is necessarily client-side: read
  (fingerprint), compare, then mutate — three separate steps if REVALIDATE is in play, two if
  not — with a real, unclosable window between the last read and the mutation, as Test 7
  demonstrates directly.
- We could not verify against live API documentation in this sandbox whether either provider
  offers a narrower, less commonly used mechanism (e.g. Stripe idempotency keys — which
  dedupe *retries of the identical request*, not concurrent *different* mutations, so they do
  not address this; or some Paddle webhook-driven optimistic-lock pattern we are not aware of).
  Absent such a mechanism, our conclusion is that **no atomic precondition+mutation primitive
  is available to SCQ on either provider's core subscription-update surface**, and this
  finding should be revisited if such a mechanism is confirmed to exist.
- The task explicitly disallowed simulating atomicity with an adapter-local lock, and this
  implementation complies: no lock, mutex, or semaphore appears anywhere in the adapters (Test
  7c enforces this at the source level). The TOCTOU window is real, present in this prototype
  exactly as it would be in a real integration, and is **not** a defect introduced by leaving
  synchronization out — synchronization was never available to add in a way that would reflect
  the real provider APIs.

## Updated capability matrix (v0.2 deltas only — full table above is still current except these rows)

| Capability | Stripe | Paddle | SCQ implication |
|---|---|---|---|
| **Exact quote→commit reproduction (proration-bearing changes)** | **SCQ_LAYER_CAN_ADD** — `proration_date` replay makes EXACT mode genuinely reproduce the quoted time-fraction-based number (confirmed by Test 6 re-run). Tax/discount recomputation (not modeled) would still be outside this guarantee. | **IMPOSSIBLE_TO_GUARANTEE** — no parameter exists to pin the time basis; EXACT mode cannot be honored for proration-bearing changes by any means available to SCQ. | This is the sharpest cross-provider asymmetry found in this cycle: identical `guaranteeMode: "EXACT"` on the same normalized proposal shape means something structurally different — and structurally weaker — on Paddle than on Stripe. A caller cannot treat EXACT as provider-neutral. |
| **Safe refusal on drift (REVALIDATE)** | **SCQ_LAYER_CAN_ADD** — re-preview-then-mutate ordering, confirmed to refuse with no mutation when outside envelope (by construction; Stripe's own re-preview in this cycle stayed inside the generous test envelope, so the refusal path was proven on Paddle, not independently re-proven on Stripe in this run — worth an explicit follow-up test with a tight Stripe envelope). | **SCQ_LAYER_CAN_ADD**, confirmed directly by Test 6c: drift detected, `QUOTE_DRIFTED` thrown, subscription verified unmutated. | REVALIDATE is the one guarantee mode this research found to be genuinely symmetric and provider-neutral. It trades exactness for honesty: the caller learns the true number before commit and can decline, rather than being told (Paddle/EXACT) or actually getting (both providers, v0.1) a number that silently doesn't match. |
| **Atomic state-precondition + mutation** | **IMPOSSIBLE_TO_GUARANTEE (native).** No compare-and-swap parameter on `subscriptions.update`. | **IMPOSSIBLE_TO_GUARANTEE (native)**, same reasoning; not independently verified against live docs (uncertainty noted). | **SCQ_LAYER_CAN_ADD, with a real gap**: SCQ's fingerprint check narrows the race window but cannot close it (Test 7). No amount of SCQ-layer engineering closes this without a provider-side primitive that does not appear to exist; a production system must accept and monitor for lost-update risk (e.g. via post-commit reconciliation against the resulting snapshot) rather than assume the window is closed. |
| **Detect concurrent mutation (revised)** | **DERIVABLE**, same as v0.1, — Test 7 shows the practical limit of this more starkly than v0.1 did: detection only works for mutations landing *before* the read step, never for ones landing in the read→write gap. | **DERIVABLE**, same. | v0.1 undersold this limitation by only testing the "landed before quote-time read" case (Test 5). v0.2's Test 7 shows the narrower, still-open case explicitly. |

## Does SCQ provide meaningful interoperability semantics beyond wrapping preview APIs? — direct answer

Evaluated against the three dimensions the task asked for:

1. **Explicit quote guarantee strength (EXACT vs REVALIDATE)**: **Yes, meaningfully — but only
   as a way of being honest about an asymmetry, not as a way of equalizing it.** Naming the two
   modes forces a caller to pick a guarantee level explicitly rather than silently getting v0.1's
   undifferentiated best-effort behavior. That is real value: it converts a silent, undocumented
   gap (v0.1's Test 6) into a typed, checkable choice. What it does *not* do is make "EXACT"
   mean the same thing on both providers — SCQ can *say* EXACT, but only Stripe can *deliver*
   it for proration math. A thin SCQ layer that just proxies the provider's own preview/update
   calls would not surface this distinction at all; that is the specific, non-trivial value
   this cycle adds over "just wrapping the preview APIs."
2. **Agent-approved commercial acceptance envelopes**: **Yes, and this is the strongest positive
   finding of the cycle.** The envelope mechanism is the only guarantee-adjacent feature that is
   fully symmetric across both providers (Test 6c/6d), because it does not depend on any
   provider-side primitive at all — it only requires a non-mutating preview call, which both
   providers have natively. This is a case where SCQ adds something no thin wrapper would:
   turning "the number might have changed, good luck" into "the number changed by exactly this
   much, and the agent pre-approved changes of at most this size, so proceed/refuse
   accordingly." A bare provider SDK gives you the preview call; it does not give you anywhere
   to state or enforce a tolerance policy against a since-superseded preview.
3. **Atomic quote/precondition commit**: **No — and this is the header-level negative finding.**
   SCQ cannot manufacture atomicity the underlying APIs don't offer. The fingerprint check is
   real value over doing nothing (it catches the class of drift that lands before the read),
   but Test 7 proves it is not a solution to the general problem, and no SCQ-layer code change
   can fix that without either provider adding a genuine compare-and-swap primitive to their
   subscription-update endpoint.

**Net finding**: SCQ's interoperability value is real but narrower than "normalize the whole
lifecycle" implies. It is strongest where the underlying operation is naturally symmetric and
non-mutating (previews, envelope-gated revalidation) and weakest where it depends on a
provider-side guarantee that only one provider (or neither) actually offers (exact replay,
atomic commit). The honest characterization is: **SCQ is a meaningful normalization + honesty
layer over preview/precondition semantics, not a guarantee layer that can grant capabilities
the underlying APIs don't have.**

## Recommendation: **MODIFY**

Not PROCEED, because two of the three research questions (EXACT guarantee parity, atomic
commit) resolved negatively for at least one provider, and shipping `guaranteeMode: "EXACT"`
as a provider-neutral option would misrepresent what Paddle can actually do — a caller who
picks EXACT because "SCQ said this mode exists" has no way to learn, from the schema alone,
that it is vacuous on one of the two supported providers.

Not KILL, because the REVALIDATE + acceptanceEnvelope combination is unambiguously good,
symmetric, real interoperability value that neither provider's raw SDK gives you, and the
TOCTOU/atomicity finding — while negative — is a legitimate, disclosable limitation rather
than evidence the whole abstraction is unworkable. Callers who need integrity guarantees can
be correctly served by REVALIDATE-with-tight-envelope plus post-commit reconciliation; that is
a real, shippable pattern, just not the stronger "EXACT" guarantee the original naming implies
is available everywhere.

Concrete modifications for the next cycle:
1. **Make `guaranteeMode: "EXACT"` provider/action-aware, not universally offered.** Either (a)
   have `createChangeQuote` throw `UNSUPPORTED_CHANGE` or a new, more precise error when EXACT
   is requested for a proration-bearing action on a provider that cannot honor it (Paddle,
   today), or (b) rename the mode so its name doesn't imply a guarantee that's provider-
   dependent (e.g. split into `EXACT_IF_SUPPORTED` and have the quote itself report which
   guarantee it actually got, rather than trusting the caller's requested mode to reflect
   reality).
2. **Default new integrations to REVALIDATE**, not EXACT, given it's the only mode with
   symmetric, verified behavior across both providers.
3. **Document the TOCTOU window as an accepted, monitored risk, not a solved problem.** A
   production system should reconcile the resulting snapshot against the intended proposal
   post-commit and alert on mismatch, since SCQ cannot prevent the race, only narrow it.
4. **Fix the REVALIDATE receipt-reading footgun**: `commercialEffect` vs `revalidatedEffect`
   is easy to misuse (reading the wrong one silently gives you the stale number). Consider
   making REVALIDATE mode return the accepted number in `commercialEffect` directly and rename
   the original quoted figure to something like `originallyQuotedEffect`, so the field a naive
   caller reads by default is the one that's actually true.

---
---

# SCQ v0.3 Research Findings

**Research question for this cycle**: is SCQ v0.3 now a coherent portable contract, even
though provider capabilities differ?

Scope implemented this cycle, matching the task exactly: `REVALIDATE` made the default
guarantee mode; `EXACT` made capability-scoped (provider- and action-specific, only ever
advertised where actually enforceable, never inferred globally); `quoteCapabilities` /
`getCapabilities()` added for capability discovery; receipt semantics fixed
(`commercialEffect`/`revalidatedEffect` replaced by `quotedEffect`/`committedEffect`, with the
EXACT-mode equality and REVALIDATE-mode divergence both enforced and tested);
`consistencyGuarantee: "ATOMIC" | "BEST_EFFORT"` added, both adapters reporting
`BEST_EFFORT`; the REVALIDATE commit order (re-preview → evaluate envelope → mutate → fetch →
receipt) confirmed already correct from v0.2 and preserved. No new providers, no payments, no
authorization, no negotiation, no usage billing were added.

All numbers and pass/fail results below are from an actual `npm test` run in this repo
(25/25 passing) — not hand-computed.

## What changed and why

- **`REVALIDATE` is now the protocol default.** `guaranteeMode` is optional on every proposal;
  when omitted, `resolveGuaranteeMode()` (a single shared function in `scq-engine.ts`, called
  identically by both adapters so the default cannot drift between them) resolves it to
  `"REVALIDATE"`. This directly implements v0.2's recommendation #2 ("default new integrations
  to REVALIDATE, not EXACT, given it's the only mode with symmetric, verified behavior"). A
  caller who does not think carefully about guarantee strength now gets the honest,
  provider-neutral behavior by default, not a false sense of exactness.
- **`EXACT` is capability-scoped and enforced, not just documented.** `capabilitiesFor(action)`
  lives once per adapter (`stripe-adapter.ts`, `paddle-adapter.ts`) and is the single source of
  truth called by BOTH `getCapabilities()` (for discovery) and `enforceGuaranteeRequest()`
  (called from `createChangeQuote`, for enforcement). This structural choice — one function,
  two call sites — is what makes "capability discovery cannot overstate guarantees" a
  provable property rather than a documentation promise: it is structurally impossible for the
  two to disagree, because they read the same function. Test 8h cross-checks this directly by
  calling both paths independently and asserting they agree, for every action, on both
  providers.
- **Requesting EXACT where unsupported is now a hard, up-front refusal.** `createChangeQuote`
  throws `UNSUPPORTED_CHANGE` before any preview call is made if EXACT is requested for a
  (provider, action) pair `capabilitiesFor` reports as unsupported. This directly fixes the
  v0.2 footgun (Test 6, v0.2): previously, requesting EXACT against Paddle for a
  proration-bearing action silently degraded to best-effort and still returned a `COMMITTED`
  receipt with numbers that had already drifted — technically-truthful in isolation, but
  misleading about what guarantee was actually delivered. v0.3's Test 6b confirms the new
  behavior: the same request now fails immediately with `UNSUPPORTED_CHANGE`, and the
  subscription is provably untouched (fingerprint unchanged) since no preview or mutation call
  ever ran.
- **`quoteCapabilities` / `getCapabilities()`**: returns `{ EXACT: boolean, REVALIDATE:
  boolean }` per `ChangeAction`. Confirmed by running it: Stripe reports `EXACT: true` for
  every action (`CHANGE_QUANTITY`, `CHANGE_PLAN`, `CHANGE_CADENCE`, `CANCEL`); Paddle reports
  `EXACT: false` for the three proration-bearing actions and `EXACT: true` only for `CANCEL`
  (Test 8a, 8b — exact JSON captured below). `REVALIDATE: true` everywhere on both providers,
  since it depends only on a non-mutating preview call, which both providers have for every
  action modeled here.
- **Receipt semantics fixed**: `commercialEffect`/`revalidatedEffect` are gone from
  `SubscriptionChangeReceipt`, replaced by `quotedEffect` (the untouched historical record of
  what was quoted) and `committedEffect` (what was actually true at the moment of mutation).
  For EXACT, `committedEffect` is *defined* to equal `quotedEffect` — enforced in code by
  literally assigning `committedEffect = validated.quoted_effect` on the EXACT path in both
  adapters, not just claimed — and Test 1 (Stripe) and Test 6 (Stripe) both assert
  `assert.deepEqual(receipt.committedEffect, receipt.quotedEffect)` and confirm it holds. For
  REVALIDATE, `committedEffect` is the freshly re-derived figure from the pre-mutation
  re-preview; Test 6d demonstrates a real case where the two legitimately differ ($200.00
  quoted vs $133.33 committed, 10 simulated days apart) and asserts `notDeepEqual` on the two
  fields to prove the receipt does NOT silently claim they matched. Test 8f is a dedicated
  schema-level regression guard asserting the old field names (`commercialEffect`,
  `revalidatedEffect`) are structurally absent from every receipt.
- **`consistencyGuarantee: "ATOMIC" | "BEST_EFFORT"`** added to both `ProviderCapabilities`
  (via `getCapabilities()`) and every `SubscriptionChangeReceipt`. Both adapters hard-code
  `"BEST_EFFORT"` — there is no code path in either adapter that could produce `"ATOMIC"`,
  which is deliberate: v0.2's Test 7 proved neither provider offers a compare-and-swap
  precondition on its subscription-update endpoint, so nothing in this repo could honestly
  claim atomicity. Test 8g confirms `BEST_EFFORT` is surfaced on both `getCapabilities()` and
  on actual receipts for both providers; Test 7's TOCTOU tests (re-run this cycle, still
  passing) now also assert `consistencyGuarantee === "BEST_EFFORT"` directly on the receipt
  that resulted from the demonstrated race, tying the abstract capability claim to the concrete
  failure mode it describes.
- **REVALIDATE commit ordering**: already correct in v0.2 (re-preview → evaluate envelope →
  mutate → fetch resulting state → receipt) and preserved unchanged in v0.3. No test in this
  cycle found a violation of this ordering; Test 6c (re-run) continues to confirm that a
  drift-refused REVALIDATE commit performs no mutation.
- **New requirement surfaced during implementation, not in the original v0.2 scope**:
  REVALIDATE (whether explicit or defaulted) now requires an `acceptanceEnvelope` for any
  action with a proration/immediate-charge component, enforced via `INVALID_PROPOSAL` at quote
  time (Test 8e). This was necessary to keep the new default honest: if REVALIDATE became the
  default AND a missing envelope silently meant "zero tolerance" (as v0.2's
  `checkAcceptanceEnvelope` already treated an absent envelope), then simply omitting
  `guaranteeMode` would work for a caller who never thought about envelopes at all, until the
  first drifted commit failed confusingly. Requiring the envelope explicitly for proration-
  bearing actions makes the "agent-approved" part of "agent-approved commercial acceptance
  envelope" actually true — an envelope is only ever agent-approved if the agent had to state
  one.

## Test results (v0.3 additions and re-runs)

25/25 tests pass. Full breakdown:

- **Test 8a** (Stripe capability report): `{"CHANGE_QUANTITY":{"EXACT":true,"REVALIDATE":true},"CHANGE_PLAN":{"EXACT":true,"REVALIDATE":true},"CHANGE_CADENCE":{"EXACT":true,"REVALIDATE":true},"CANCEL":{"EXACT":true,"REVALIDATE":true}}`
- **Test 8b** (Paddle capability report): `{"CHANGE_QUANTITY":{"EXACT":false,"REVALIDATE":true},"CHANGE_PLAN":{"EXACT":false,"REVALIDATE":true},"CHANGE_CADENCE":{"EXACT":false,"REVALIDATE":true},"CANCEL":{"EXACT":true,"REVALIDATE":true}}`
  — both captured verbatim from an actual `getCapabilities()` call, not hand-authored.
- **Test 8c / 8c2** (EXACT refused where unsupported): requesting `guaranteeMode: "EXACT"` for
  Paddle `CHANGE_QUANTITY` and `CHANGE_CADENCE` both throw `UNSUPPORTED_CHANGE` at
  `createChangeQuote` time, confirmed via `assert.rejects`.
- **Test 8d** (default resolution): omitting `guaranteeMode` resolves to `"REVALIDATE"` on the
  returned quote for both Stripe and Paddle.
- **Test 8e** (envelope requiredness): omitting both `guaranteeMode` and `acceptanceEnvelope`
  on a `CHANGE_QUANTITY` proposal throws `INVALID_PROPOSAL` — the default cannot be exploited
  to skip stating a tolerance.
- **Test 8f** (receipt schema): asserts `quotedEffect` and `committedEffect` are always present
  and typed correctly, `guaranteeMode` and `consistencyGuarantee` are always present, and the
  old field names are structurally absent.
- **Test 8g** (BEST_EFFORT surfacing): confirmed present on `getCapabilities()` and on an
  actual `CANCEL` receipt, for both providers.
- **Test 8h** (capability discovery cannot overstate guarantees — the core structural claim of
  this cycle): independently exercises `getCapabilities()` and actual `createChangeQuote`
  enforcement for `CHANGE_QUANTITY` and `CHANGE_CADENCE` on both providers and asserts they
  agree. Passed with "no drift found" on this run; because both paths read the same
  `capabilitiesFor()` function, this is closer to a structural guarantee than a probabilistic
  test result — the test exists to catch a future edit that adds a second, diverging
  capability table by accident, not because the current code was found to disagree in this run.
- **Test 6 (re-run, Stripe/EXACT)**: unchanged finding from v0.2 — `proration_date` replay
  reproduces the quoted $200.00 charge even after 10 simulated days, confirmed via
  `assert.deepEqual(receipt.committedEffect, receipt.quotedEffect)`.
- **Test 6b (NEW, replaces v0.2's "Paddle EXACT silently drifts" test)**: requesting EXACT for
  Paddle `CHANGE_QUANTITY` now fails immediately with `UNSUPPORTED_CHANGE`, confirmed with the
  subscription's fingerprint unchanged (no preview or mutation call ran). This is a strictly
  better outcome than v0.2's: previously the request succeeded and produced a misleading
  receipt; now it fails loudly and immediately.
- **Test 6c/6d (re-run)**: Paddle REVALIDATE still refuses via `QUOTE_DRIFTED` with no mutation
  when a zero-tolerance envelope is exceeded; Stripe REVALIDATE still commits at the newly
  re-derived $133.33 figure (not the stale $200.00), with `receipt.committedEffect` and
  `receipt.quotedEffect` now asserted `notDeepEqual` to prove the divergence is visible on the
  receipt rather than papered over.
- **Test 7 (re-run, TOCTOU)**: unchanged finding — concurrent write injected between
  validation and mutation is silently clobbered on both providers — now additionally asserts
  `receipt.consistencyGuarantee === "BEST_EFFORT"` on the exact receipt produced by the
  demonstrated race, so the "this is why it's not ATOMIC" claim is tied to a concrete,
  reproduced failure rather than asserted in isolation.

## Final core schema changes (v0.2 → v0.3)

```ts
// guaranteeMode is now OPTIONAL; REVALIDATE is the resolved default.
// acceptanceEnvelope is likewise optional in the TYPE (required at runtime
// for proration-bearing actions under the effective mode — see
// enforceGuaranteeRequest in scq-engine.ts).
type GuaranteeFields = {
  guaranteeMode?: "EXACT" | "REVALIDATE";
  acceptanceEnvelope?: AcceptanceEnvelope;
};

// NEW: capability discovery, added to the SubscriptionProvider interface.
type GuaranteeSupport = { EXACT: boolean; REVALIDATE: boolean };
type QuoteCapabilities = Partial<Record<ChangeAction, GuaranteeSupport>>;
type ConsistencyGuarantee = "ATOMIC" | "BEST_EFFORT";
type ProviderCapabilities = {
  quoteCapabilities: QuoteCapabilities;
  consistencyGuarantee: ConsistencyGuarantee;
};
interface SubscriptionProvider {
  // ...existing methods unchanged...
  getCapabilities(): ProviderCapabilities;
}

// CHANGED: quote now echoes back the effective guarantee mode it was
// created under, so a caller never has to re-derive the default themselves.
type SubscriptionChangeQuote = {
  // ...existing fields unchanged...
  guaranteeMode: "EXACT" | "REVALIDATE"; // NEW — always the resolved/effective mode
};

// CHANGED: receipt semantics. commercialEffect/revalidatedEffect REMOVED,
// replaced by quotedEffect/committedEffect. guaranteeMode and
// consistencyGuarantee added so a receipt is self-describing.
type SubscriptionChangeReceipt = {
  quoteId: string;
  subscriptionRef: string;
  status: "COMMITTED";
  resultingSnapshot: SubscriptionSnapshot;
  quotedEffect: CommercialEffect;      // NEW name (was commercialEffect) — untouched historical record
  committedEffect: CommercialEffect;   // NEW name (was revalidatedEffect, and was optional) — always present;
                                        // === quotedEffect for EXACT by construction, may differ for REVALIDATE
  guaranteeMode: "EXACT" | "REVALIDATE";     // NEW
  consistencyGuarantee: "ATOMIC" | "BEST_EFFORT"; // NEW — both adapters always report BEST_EFFORT
  committedAt: string;
};
```

## Updated capability matrix (v0.3 view — supersedes the "Exact quote→commit reproduction" row from v0.2)

| Capability | Stripe | Paddle | SCQ implication |
|---|---|---|---|
| **EXACT support, CHANGE_QUANTITY / CHANGE_PLAN / CHANGE_CADENCE** | **SCQ_LAYER_CAN_ADD** — advertised `true`, backed by `proration_date` replay, verified equal via `assert.deepEqual` in tests. | **IMPOSSIBLE_TO_GUARANTEE** — advertised `false`. No code path can set this `true` without inventing a mechanism Paddle doesn't have. | Capability discovery now makes this asymmetry a queryable fact (`getCapabilities().quoteCapabilities.CHANGE_QUANTITY.EXACT`), not something a caller has to learn from documentation or a failed request. |
| **EXACT support, CANCEL** | **NATIVE** (trivially — no proration component exists to fail to pin). | **NATIVE**, same reasoning. | The one action where both providers are symmetric — correctly reflected as `true` on both. |
| **REVALIDATE support, all actions** | **SCQ_LAYER_CAN_ADD** — advertised `true` everywhere. | **SCQ_LAYER_CAN_ADD** — advertised `true` everywhere. | Confirmed fully symmetric across both providers and all four actions — this is the mode SCQ should steer callers toward, which is why it is now the default. |
| **Capability discovery accuracy** | **SCQ_LAYER_CAN_ADD**, verified by Test 8h against Stripe's actual `createChangeQuote` enforcement. | **SCQ_LAYER_CAN_ADD**, verified by Test 8h against Paddle's actual enforcement. | Because `getCapabilities()` and `enforceGuaranteeRequest()` both read the same `capabilitiesFor()` function per adapter, this property is structural, not just tested — but the test exists so a future edit that duplicates the table can't silently break it. |
| **Consistency guarantee (ATOMIC vs BEST_EFFORT)** | **IMPOSSIBLE_TO_GUARANTEE (native)** — no compare-and-swap on `subscriptions.update`; reports `BEST_EFFORT`. | **IMPOSSIBLE_TO_GUARANTEE (native)**, same; reports `BEST_EFFORT`. | Unchanged from v0.2's finding, now typed and queryable via `getCapabilities().consistencyGuarantee` and every receipt, rather than only documented in prose. |
| **Receipt self-description (does a receipt tell you which guarantee it actually got?)** | **SCQ_LAYER_CAN_ADD** — `guaranteeMode` and `consistencyGuarantee` present on every receipt. | **SCQ_LAYER_CAN_ADD**, same. | Directly closes the v0.2-identified "REVALIDATE receipt-reading footgun": a caller can no longer misread a stale `quotedEffect` as authoritative, because `committedEffect` is always present and unambiguously named. |

## Remaining protocol gaps

These are not closed by v0.3 and should not be read as resolved:

1. **BEST_EFFORT consistency is disclosed, not fixed.** v0.3 makes the TOCTOU race visible and
   typed; it does not close the race. A production system still needs its own reconciliation
   strategy (e.g. post-commit diff against intent, or idempotency-key-based retry safety) —
   SCQ can tell you the guarantee is weak, it cannot make it strong.
2. **EXACT's scope, even where advertised `true`, is narrower than "every dollar guaranteed."**
   Stripe's `proration_date` pins only the time-fraction component of proration. Tax and
   discount/coupon recomputation (not modeled by either sim) happen independently at
   invoice-generation time on real Stripe and are NOT pinned by `proration_date`. `EXACT: true`
   in `quoteCapabilities` should be read as "the modeled proration math is guaranteed," not
   "the final invoiced amount is guaranteed under all circumstances" — this repo's sims don't
   model tax/discounts at all, so this is a documented extrapolation, not something directly
   tested here.
3. **`quoteCapabilities` is action-level, not proposal-level.** A provider's real capability
   can in principle depend on finer detail than the action alone (e.g. a Stripe subscription
   using a different proration mode, or a Paddle subscription with an active discount that
   changes what's derivable). This repo's sims don't have enough proposal-shape variety to
   surface such a case, so v0.3's capability model is coarser than reality might eventually
   require — flagged here rather than assumed away.
4. **No test yet exercises capability discovery drifting from enforcement as a genuine
   regression** (only the current-state agreement is tested). Test 8h would catch someone
   editing `capabilitiesFor()` in one adapter without updating the corresponding
   `getCapabilities()` call site if those two things had been implemented as separate tables —
   but since they're structurally the same function call in this repo, the test's real value is
   as a tripwire against a *future* refactor that splits them apart, not as evidence of a
   currently-hidden bug.
5. **Multi-provider comparability of `quoteCapabilities` itself is untested.** Nothing in this
   cycle verifies that a caller who reads `quoteCapabilities` from two different providers and
   makes a routing decision (e.g. "prefer EXACT-capable providers for this action") gets
   sensible results — that's a caller-side integration concern one level up from what this
   research prototype models, and would matter more once a third provider is added.

## Direct answer: is SCQ v0.3 now a coherent portable contract, even though provider capabilities differ?

**Yes — with the definition of "portable" narrowed to something honest rather than something
uniform.** v0.3 does not make Stripe and Paddle capable of the same things; it makes the
*shape of the disagreement* portable. Every (provider, action) pair now answers the same two
questions through the same typed interface — `getCapabilities().quoteCapabilities[action]` for
"what can I get," and `receipt.guaranteeMode` / `receipt.consistencyGuarantee` for "what did I
actually get" — and those answers are provably consistent with what `createChangeQuote` and
`commitChangeQuote` actually do, not just documented as consistent (Test 8h). A caller
integrating against SCQ v0.3 can write provider-agnostic code that asks "does this provider
support EXACT for this action?" before deciding whether to request it, rather than either
hard-coding provider-specific branches or discovering the answer via a failed request (v0.2)
or a silently wrong receipt (also v0.2, pre-fix).

What v0.3 does NOT do — and could not do without misrepresenting the underlying APIs — is make
the *guarantees themselves* portable. `EXACT` on Stripe and the absence of `EXACT` on Paddle
for the same action are not two flavors of one underlying capability; they are genuinely
different capabilities, and a coherent contract's job is to make that difference legible, not
to paper over it with a uniform-looking field that means different things per provider (which
is precisely the v0.2 failure mode this cycle fixes). A portable protocol over non-portable
provider capabilities is a portable *contract for discovering and respecting the
differences* — that is what v0.3 delivers, and it is a materially different (and more honest)
claim than "SCQ makes Stripe and Paddle work the same way."

## Recommendation: **MODIFY**

Not PROCEED, because the remaining protocol gaps above are real and would matter as soon as a
third provider or a production integration is attempted — most importantly, `EXACT`'s scope
being narrower than "every dollar guaranteed" even where advertised `true` is a nuance the
current schema cannot express (it's a boolean, not a description of what's covered), and
BEST_EFFORT consistency still leaves the TOCTOU race entirely to the caller to manage.

Not KILL — this cycle's central finding is unambiguously positive: the schema can now be made
structurally incapable of overstating a guarantee (Test 8h's structural argument, not just its
passing result), and the REVALIDATE-by-default change closes the single most dangerous v0.2
footgun (a caller getting EXACT-shaped confidence from a REVALIDATE-shaped or unsupported
guarantee) without requiring any new provider capability. That is real, durable progress
achieved entirely at the SCQ layer.

Concrete direction for the next cycle, if pursued:
1. **Refine `EXACT`'s semantics from a boolean to a scoped claim** — e.g.
   `{ EXACT: { timeFraction: true, tax: "UNKNOWN", discounts: "UNKNOWN" } }` — so the schema
   itself communicates that Stripe's EXACT covers proration timing but not tax/discount
   recomputation, rather than requiring a reader to find that caveat in prose.
2. **Before adding Chargebee/Zuora**, stress-test whether `quoteCapabilities`'s current
   action-level granularity survives a third provider with a genuinely different capability
   shape (e.g. a provider with partial EXACT support gated on subscription state, not just
   action type) — that is likely to be the first real test of whether the v0.3 schema
   generalizes or was fit to exactly two providers' current behavior.
3. **Give BEST_EFFORT a companion mitigation primitive** (e.g. a documented idempotency-key
   convention, or a required post-commit reconciliation step) rather than leaving "BEST_EFFORT"
   as a label with no corresponding guidance on what a caller should actually do about it.

---
---

# SCQ v0.4 Research Findings — Zuora Validation

**Research question for this cycle**: does SCQ describe a genuinely portable commercial-change
contract across Stripe, Paddle, AND Zuora, or was it only a useful abstraction for simpler
(Stripe/Paddle-shaped) billing systems? Zuora was chosen specifically because it is not a
second Stripe-shaped subscription-billing API — it is an enterprise order/contract system
(Subscription → RatePlan → RatePlanCharge, driven by an Orders API with `orderActions`,
explicit `effectiveDate`s, and a real contract-term object) with fundamentally different
primitives for versioning, previewing, and applying changes.

Scope implemented this cycle, matching the task exactly: a Zuora adapter and sim covering only
CHANGE_QUANTITY, CHANGE_PLAN, CHANGE_CADENCE, and CANCEL; mapping of Zuora's native
subscription/version, order preview, order actions, effective dates, contract terms, and
renewal/cancellation semantics; replacement of the v0.3 `{ EXACT: boolean; REVALIDATE: boolean
}` pair with the task's proposed `guaranteeCoverage` shape (renamed `GuaranteeCoverage` in code
for TypeScript naming conventions, same fields) — this WAS required, not optional, because
Zuora's real capability shape genuinely does not collapse into one boolean per action (see
below); `consistencyGuarantee: "ATOMIC" | "BEST_EFFORT"` kept, with Zuora's real native version
field investigated specifically for whether it changes that answer (it does not); and
contract-heavy test scenarios (monthly→annual, commitment creation/alteration, cancellation
during a committed term, quantity change with a future effective date). No Chargebee/Zuora-
adjacent scope creep, no new SCQ actions or payment/negotiation/usage-billing concepts were
added.

All 35 tests pass (`npm test`) — up from v0.3's 25, with the 10 new tests in
`tests/test9-zuora.test.ts`. Two genuine implementation bugs were found and fixed during this
work (not glossed over): (1) the Zuora sim's `CancelSubscription` order action unconditionally
set subscription status to `Cancelled` regardless of the order's stated `effectiveDate`, which
would have made a `PERIOD_END`-equivalent cancellation behave identically to an immediate one
— fixed to only flip status once the effective date has actually arrived, matching how the
Stripe/Paddle adapters model scheduled cancellation; (2) the adapter initially used real
wall-clock `new Date()` to compute the Zuora order's `effectiveDate`, which desynchronized from
the sim's own simulated clock (fixed test fixtures run on `2026-08-01`, but real wall-clock
`new Date()` returns whatever today's real date is) — fixed by using `sim.currentTime()` for
the order-facing date and keeping real wall-clock time separately for SCQ's own quote-TTL
bookkeeping, mirroring (and now making explicit) a distinction the Stripe/Paddle adapters
already relied on implicitly.

## What changed and why

- **Zuora adapter + sim** (`src/adapters/zuora-sim.ts`, `src/adapters/zuora-adapter.ts`): an
  in-memory fake modeling Zuora's Orders API — `Subscription.version` (a real, native,
  monotonic integer, incremented by the sim on every order, mirroring documented Zuora
  behavior), `POST /orders/preview` (non-mutating), `POST /orders` (mutating, one order can
  carry multiple `orderActions` that apply atomically as a single version bump), and a real
  `ZuoraTermStructure` object (`initialTerm`, `renewalTerm`, `autoRenew`, `termEndDate`, etc.)
  — a genuinely richer contract-term model than Stripe/Paddle's complete absence of one. CHANGE_*
  actions map onto Zuora order actions: CHANGE_QUANTITY → a single `UpdateProduct`;
  CHANGE_PLAN/CHANGE_CADENCE → `RemoveProduct` + `AddProduct` pairs; CANCEL →
  `CancelSubscription` with a `cancellationPolicy`.
- **`GuaranteeCoverage` replaces `GuaranteeSupport`** (the task's proposed
  `immediateFinancialEffect` / `recurringFinancialEffect` / `termEffect` / `effectiveAt` shape,
  implemented verbatim except `termEffect` uses `"EXACT" | "UNKNOWN"` rather than `"EXACT" |
  "REVALIDATE"` — there is no non-mutating "re-check the term consequence" call materially
  different from the order preview itself, so REVALIDATE would be a distinction without a
  difference for that one dimension; UNKNOWN was already SCQ's established sentinel for "the
  provider cannot answer this," so it was reused rather than inventing a new one). This split
  was FORCED, not chosen for its own sake: Zuora's financial dimensions are EXACT for every
  action modeled (order pricing is a deterministic function of rate-plan-charge values and the
  order's own `effectiveDate`, not ambient wall-clock time — see Test 9c), while `termEffect` is
  UNKNOWN for CHANGE_PLAN/CHANGE_CADENCE/CANCEL specifically because a bare rate-plan swap or
  cancellation, without an accompanying `TermsAndConditions` order action, does not reliably
  surface renewal-anchor or early-termination consequences from the preview response alone (see
  zuora-sim.ts's extensive file-header documentation of this exact gap). A single boolean could
  not express "financially exact, term-wise unknown" — this is the concrete evidence that v0.3's
  recommendation to refine EXACT before adding a third provider was correct.
- **This split also corrected a real inaccuracy in Stripe's and Paddle's own v0.3 capability
  reports** (documented and fixed as part of this cycle, in the adapters themselves, not just
  in prose): v0.3 reported `EXACT: true` for Stripe's CHANGE_QUANTITY/CHANGE_PLAN/CHANGE_CADENCE
  because `proration_date` replay pins the financial numbers — but v0.3 had no separate field to
  be honest that Stripe's `termEffect` was ALWAYS `UNKNOWN` for those actions (a plain Stripe
  subscription has no contract-term object at all; this was already documented in
  `SubscriptionSnapshot.term.commitmentUntil: "UNKNOWN"` since v0.1, just never surfaced in the
  capability report). Under v0.4's per-dimension split, an overall `guaranteeMode: "EXACT"`
  request for those actions is now correctly refused on BOTH Stripe and Paddle — only `CANCEL`
  (where "does this create a commitment" is exactly answerable as "no" on all three providers)
  supports a full EXACT request. This is a genuine correction surfaced by adding Zuora, not an
  artifact of Zuora-specific code: the dimension split forced the question "what does EXACT
  actually cover" to be answered honestly for the existing two providers as well.
- **`enforceGuaranteeRequest` (scq-engine.ts)** now checks every `GuaranteeCoverage` dimension
  independently: an overall `guaranteeMode: "EXACT"` proposal is refused with `UNSUPPORTED_CHANGE`
  naming the first failing dimension if ANY of the four dimensions is not `"EXACT"` for that
  action. This is deliberately conservative (see "concepts that failed to normalize" below for
  why a narrower, per-dimension EXACT request was NOT added this cycle) but is provably correct
  for the "no overstated guarantee" requirement: Test 8c2 specifically constructs the case where
  BOTH financial dimensions are EXACT but the request is still refused because termEffect is not,
  proving the check inspects every dimension rather than short-circuiting on the financial ones.
- **`consistencyGuarantee` stays `BEST_EFFORT` for Zuora too**, despite Zuora having a
  qualitatively stronger native concurrency primitive than Stripe or Paddle (see next section)
  — this is the direct, tested answer to "does Zuora provide stronger native concurrency/version
  semantics than Stripe/Paddle": yes for DETECTION, no for ATOMICITY, and the schema correctly
  reflects only the latter.

## Does Zuora provide stronger native concurrency/version semantics than Stripe/Paddle?

**Yes, for staleness detection — no, for atomic commit.** This is the most interesting single
finding of the cycle and deserves its own section rather than being buried in the capability
table.

- **Stronger detection**: Zuora subscriptions carry a real, documented, monotonic `version`
  integer that increments on every order, full stop. This is qualitatively different from
  Stripe/Paddle, which have NOTHING analogous — v0.1-v0.3 had to invent a SHA-256 content hash
  over a hand-picked set of mutable fields as a workaround, and that hash is only as good as the
  fields someone remembered to include in it (Test 6/6e's entire finding was about a dimension —
  wall-clock time — the hash structurally cannot cover). Zuora's version field has no such
  blind spot: ANY order, touching ANY field, bumps it. Test 9h confirms this catches a
  concurrent out-of-band order exactly as reliably as Stripe/Paddle's fingerprint catches a
  concurrent mutation, but with a strictly stronger underlying guarantee (native, provider-
  guaranteed monotonicity vs. a client-side approximation).
- **NOT stronger atomicity**: `POST /v1/orders` does not accept a "create this order ONLY IF the
  subscription's version is still N" precondition parameter, as far as we could determine
  (uncertainty flagged — not independently verified against live Zuora API docs in this
  sandbox). This means SCQ's read-version-then-create-order sequence is STILL two separate
  calls with a race window, structurally identical to Stripe/Paddle's read-fingerprint-then-
  update sequence. Test 9i proves this directly: an out-of-band order injected between SCQ's
  version check and its own `createOrder()` call is silently overwritten with no conflict
  signal, the exact same outcome as v0.2's Stripe/Paddle TOCTOU test (Test 7), just reached via
  a version-integer comparison instead of a hash comparison.
- **The practical upshot**: a stronger detection primitive changes what SCQ can reliably
  DETECT (Zuora: any concurrent order, full stop; Stripe/Paddle: only changes to
  hash-covered fields) but does not change what SCQ can PREVENT (nothing, on any of the three
  providers, without a provider-side compare-and-swap primitive that none of them appear to
  offer). `consistencyGuarantee: "BEST_EFFORT"` is correct for Zuora for exactly this reason —
  and the schema's decision to make this a separate field from the version/fingerprint quality
  itself (rather than inferring consistency strength FROM detection quality) is validated by
  this exact case: a reader who saw "Zuora has a real version field" and assumed that meant
  stronger consistency would have been wrong, and the schema does not let them make that
  mistake, because `consistencyGuarantee` is asked and answered independently.

## Test results

35/35 tests pass. Highlights from the 10 new Zuora tests (`test9-zuora.test.ts`):

- **Test 9a/9b** (capability discovery): Zuora reports full `EXACT` coverage (all four
  dimensions) ONLY for `CHANGE_QUANTITY`; `CHANGE_PLAN`/`CHANGE_CADENCE`/`CANCEL` report EXACT
  financial dimensions but `UNKNOWN` termEffect. `consistencyGuarantee` is `BEST_EFFORT`
  despite the real version field (see above).
- **Test 9c** (CHANGE_QUANTITY, EXACT, 10 simulated days elapsed): quoted a **$200.00**
  immediate charge; committed **exactly $200.00** after 10 days passed, with NO pinning
  mechanism analogous to Stripe's `proration_date` needed — Zuora's order math was never
  wall-clock-dependent in the first place, because the order's own `effectiveDate` (not "now")
  is what the math is computed against, and that date is captured and replayed verbatim as an
  ordinary input, not a special-cased workaround.
- **Test 9d** (MONTHLY→ANNUAL, contract-heavy case #1): recurring amount ($10,000.00/yr) and
  cadence are exactly derivable; an overall EXACT request is correctly refused (termEffect
  UNKNOWN); REVALIDATE correctly reports `term.createsCommitment`/`commitmentUntil` as
  `UNKNOWN` — a documented finding that Zuora's gap here, while real, is narrower and more
  specific than Stripe/Paddle's (Zuora HAS a term object; it just isn't reliably populated by a
  bare plan-swap preview without an explicit `TermsAndConditions` action alongside it).
- **Test 9e** (CANCEL of an evergreen subscription, contract-heavy case #2 — no committed term
  to alter): the ACTION-level capability report says CANCEL's termEffect is UNKNOWN, and an
  overall EXACT request is correctly refused on that basis — but the ACTUAL quote for this
  specific (evergreen) subscription resolves `createsCommitment` to `false`, not `UNKNOWN`,
  because for this subscription the answer genuinely is fully known. This is deliberately kept
  as a demonstrated tension, not hidden: the capability report's granularity (per action) is
  coarser than what's actually knowable (per action ∧ per subscription state) — see "concepts
  that failed to normalize" below.
- **Test 9f** (cancellation during a committed 12-month term, contract-heavy case #3): the
  order's own immediate financial effect is reported, but `term.createsCommitment` is
  explicitly `UNKNOWN` — modeling the genuine, real gap that early-termination fee logic in
  Zuora commonly lives in account/product configuration OUTSIDE the order itself, which a bare
  order preview does not reliably surface. The sim deliberately does not guess at a fee amount
  or assume none applies.
- **Test 9g** (quantity change with a future effective date, contract-heavy case #4): a
  15-days-out `UpdateProduct` order action was previewed and then replayed with the identical
  `effectiveDate`, producing IDENTICAL numbers — confirmed deterministic, unlike Stripe/Paddle's
  wall-clock-at-call-time proration. This test necessarily exercises the Zuora SIM directly
  rather than through `ZuoraAdapter.createChangeQuote`, because SCQ's `SubscriptionChangeProposal`
  schema has no field letting a caller request an arbitrary future effective date — see
  "concepts that failed to normalize" below, this is the cycle's most significant genuine schema
  gap.
- **Test 9h** (stale quote via Zuora's real version field): identical `QUOTE_STALE` / no-
  mutation outcome to Stripe/Paddle's v0.1 Test 5, reached via a fundamentally different (and
  more reliable) detection mechanism.
- **Test 9i** (TOCTOU via Zuora's real version field): identical silent-clobber outcome to
  Stripe/Paddle's v0.2 Test 7 — proving the stronger detection primitive does not change the
  atomicity finding (see dedicated section above).
- **Test 9j**: capability-discovery-cannot-overstate-guarantees, extended to the third provider
  — no drift found between `getCapabilities()` and actual enforcement.

## Zuora capability matrix

| Capability | Stripe | Paddle | Zuora | SCQ implication |
|---|---|---|---|---|
| **Stable subscription version** | IMPOSSIBLE_TO_GUARANTEE (native) — no version/etag field | IMPOSSIBLE_TO_GUARANTEE (native), same | **NATIVE** — a real, documented, monotonic `version` integer that increments on every order | SCQ_LAYER_CAN_ADD for Stripe/Paddle (synthetic hash workaround); for Zuora the native field is used DIRECTLY, no workaround needed — a qualitatively different, stronger situation |
| **immediateFinancialEffect: EXACT** | EXACT for all actions (via `proration_date` replay) | REVALIDATE-only for CHANGE_QUANTITY/PLAN/CADENCE (no pin mechanism); EXACT for CANCEL | **EXACT for all four actions** — order pricing is deterministic given (rate plan charges, effectiveDate), no pin needed because there was never a wall-clock dependency to defeat | Zuora's financial-EXACT is structurally more robust than Stripe's: Stripe needs an explicit workaround (`proration_date`) to achieve determinism; Zuora is deterministic by the shape of its own API |
| **recurringFinancialEffect: EXACT** | same as above | same as above | same as immediateFinancialEffect | same reasoning |
| **termEffect: EXACT** | UNKNOWN for CHANGE_QUANTITY/PLAN/CADENCE (no contract-term object at all); EXACT for CANCEL only (vacuously — nothing to affect) | UNKNOWN for CHANGE_QUANTITY/PLAN/CADENCE, same reasoning; EXACT for CANCEL only | **EXACT for CHANGE_QUANTITY** (provably no term interaction for a plain quantity change); **UNKNOWN for CHANGE_PLAN/CHANGE_CADENCE/CANCEL** (real term object exists, but a bare order preview does not reliably surface renewal-anchor or early-termination interactions without an explicit accompanying order action) | Zuora's gap here is narrower and more specific than Stripe/Paddle's total absence of a term concept — "the concept exists but isn't always surfaced" is a meaningfully different (and more fixable, with a richer order) kind of gap than "the concept doesn't exist" |
| **effectiveAt: EXACT** | EXACT (mutations apply "now" or a fixed known period-end) | EXACT, same reasoning | **EXACT** — effectiveDate is a caller-supplied INPUT to the order, never silently substituted by the provider | All three are EXACT here, but for different reasons: Stripe/Paddle because there's no future-dating concept to introduce risk; Zuora because future-dating exists AND is a faithfully-replayed input, not ambient state |
| **Detect concurrent mutation** | DERIVABLE (client-side hash re-check) | DERIVABLE, same | **NATIVE** (server-guaranteed monotonic version) | Zuora's detection is genuinely stronger; SCQ_LAYER_CAN_ADD still applies to consuming it correctly (the adapter must actually check it, which it does) |
| **Atomic state-precondition + mutation** | IMPOSSIBLE_TO_GUARANTEE (native) | IMPOSSIBLE_TO_GUARANTEE (native) | **IMPOSSIBLE_TO_GUARANTEE (native)** — a stronger version field does not imply a compare-and-swap `createOrder` parameter, and none was found/assumed to exist (uncertainty noted) | Consistency guarantee is BEST_EFFORT on ALL THREE providers, for the same structural reason (client-side read-check-write), despite Zuora's detection primitive being strictly better |
| **Expose commitment/contract-term semantics** | IMPOSSIBLE_TO_GUARANTEE — no contract-term object exists at all | IMPOSSIBLE_TO_GUARANTEE, same | **DERIVABLE, conditionally** — a REAL term object exists (`initialTerm`, `renewalTerm`, `autoRenew`, `termEndDate`) and is fully populated for a subscription's CURRENT state; whether a given ORDER's effect on that term is derivable depends on the order action type (see termEffect row) | Zuora is the only provider where this capability is "sometimes yes, in a specific documented way" rather than "structurally never" — the richest, most nuanced row in the whole matrix across all three providers |
| **Expose cancellation semantics (immediate vs scheduled)** | NATIVE — `cancel_at_period_end` | NATIVE — `scheduledChange` | **NATIVE** — `CancelSubscription` order action's `effectiveDate`, with the sim correctly modeling "still Active until that date, autoRenew false" for a future-dated cancellation (Test 9e/9f) | Cleanly normalizable on all three; confirmed for Zuora specifically after fixing a genuine sim bug that had this wrong initially (see summary) |
| **Expose early-termination / commitment-breach consequences of cancellation** | N/A — no committed-term concept to breach | N/A, same | **IMPOSSIBLE_TO_GUARANTEE** for cancellation during an active committed term — the order preview alone does not reliably surface whether an early-termination charge applies, because that logic frequently lives in account/product configuration outside the order (Test 9f) | This is a capability question that does not even exist for Stripe/Paddle (nothing to have a term-breach consequence FOR) — a genuinely new row Zuora forced into the matrix, matching the task's instruction to only add dimensions a real provider difference requires |

## Schema changes actually required

```ts
// REPLACED: v0.3's GuaranteeSupport
// type GuaranteeSupport = { EXACT: boolean; REVALIDATE: boolean };
// WITH the task's proposed per-dimension shape (renamed GuaranteeCoverage for TS convention):
type GuaranteeCoverage = {
  immediateFinancialEffect: "EXACT" | "REVALIDATE";
  recurringFinancialEffect: "EXACT" | "REVALIDATE";
  termEffect: "EXACT" | "UNKNOWN"; // NOT "EXACT" | "REVALIDATE" — see rationale above
  effectiveAt: "EXACT" | "REVALIDATE";
};
type QuoteCapabilities = Partial<Record<ChangeAction, GuaranteeCoverage>>;

// enforceGuaranteeRequest (scq-engine.ts) now checks ALL FOUR dimensions
// for an overall EXACT request, naming the first failing one:
function enforceGuaranteeRequest(action, effectiveMode, coverage: GuaranteeCoverage, envelope) {
  if (effectiveMode === "EXACT") {
    const failingDimension = COVERAGE_DIMENSIONS.find((dim) => coverage[dim] !== "EXACT");
    if (failingDimension) throw new SCQError("UNSUPPORTED_CHANGE", /* ... names failingDimension ... */);
  }
  // ...REVALIDATE envelope requirement unchanged from v0.3...
}
```

No other core type changed. `SubscriptionChangeQuote`, `SubscriptionChangeReceipt`,
`ConsistencyGuarantee`, `SCQErrorCode`, and `SubscriptionProvider` are unchanged from v0.3 —
Zuora's genuinely different object model (orders, contract terms, a real version field) was
fully absorbed by the EXISTING `SubscriptionSnapshot.term`, `CommercialEffect.term`, and
`preconditions.subscriptionVersion` fields, using the `UNKNOWN` sentinel where Zuora's answer
genuinely isn't derivable from a bare order preview. This is itself a finding: the v0.1-v0.3
schema's generality (leaving term semantics as an open `string | UNKNOWN` rather than something
Stripe/Paddle-shaped) is exactly what let Zuora's much richer term data slot in without further
schema changes — only the GUARANTEE-REPORTING shape (`GuaranteeCoverage`) needed to change, not
the DATA shape.

## Concepts that failed to normalize

Per the task's explicit instruction, documented here rather than hidden in the adapter:

1. **No SCQ field lets a caller request an arbitrary future effective date.**
   `SubscriptionChangeProposal`'s `effectivePolicy` is only ever `"IMMEDIATE"` (or
   `"PERIOD_END"` for CANCEL specifically). Zuora genuinely supports scheduling ANY of the four
   actions on an arbitrary future date as a first-class, native concept (Test 9g demonstrates
   the mechanism directly against the sim). Stripe/Paddle have nothing like this at all (their
   mutations are "now" or a fixed period-end only) — which is precisely why v0.3 removed
   `NEXT_PERIOD` as a false promise. Zuora's future-dating is NOT a false promise; it's real,
   and SCQ v0.4 has no way to let a caller ask for it. This is the single most significant
   concept lost this cycle — not because it's unrepresentable in principle, but because
   extending it wasn't required to pass this cycle's required test set (which only asked for a
   future-effective-date TEST, not adapter-level support), and the task said not to add SCQ
   features unless Zuora forces them. Whether it's forced enough to justify a v0.5 schema change
   is a judgment call for the next cycle, not resolved here.
2. **Capability discovery granularity is per-action, not per-(action, subscription-state).**
   Test 9e demonstrates this directly: CANCEL's termEffect is UNKNOWN at the capability-report
   level (correct for a subscription that MIGHT be under a committed term), but for a
   SPECIFIC evergreen subscription the true answer is fully knowable and the quote correctly
   resolves it — the capability report and the actual per-quote answer can legitimately diverge,
   and v0.4 keeps this tension visible rather than either (a) reporting EXACT at the capability
   level and being wrong for committed-term subscriptions, or (b) refusing to ever resolve
   `createsCommitment` to a concrete value even when it's knowable. Neither existing providers'
   simpler capability shape forced this question — Stripe/Paddle have no per-subscription state
   that changes their term-derivability, so this is a genuinely new kind of gap Zuora surfaced.
3. **A single order can bundle multiple order actions atomically (one version bump for
   several changes), and SCQ has no way to express "propose several changes as one atomic
   unit."** SCQ's `SubscriptionChangeProposal` is fundamentally single-action
   (CHANGE_QUANTITY XOR CHANGE_PLAN XOR CHANGE_CADENCE XOR CANCEL). Zuora's CHANGE_PLAN and
   CHANGE_CADENCE mappings in this adapter already use TWO order actions
   (RemoveProduct+AddProduct) bundled into ONE order/one version bump — which the adapter does
   correctly, but only because it's constructing that pair itself, invisibly, inside a single
   SCQ action. A caller cannot ask SCQ to bundle, say, a quantity change AND a plan change into
   one atomic commit; each requires its own quote/commit cycle, each its own version check, each
   its own race window. Zuora's real capability here (multi-action atomic orders) is STRICTLY
   BETTER than what any of SCQ's three actions individually could offer, and SCQ's one-action-
   per-proposal shape cannot express it. Not fixed this cycle — flagged as a real capability SCQ
   currently cannot let a caller reach.
4. **Whether Zuora exposes a genuine compare-and-swap order-creation parameter remains
   unverified, not just "assumed absent."** Every other provider limitation in this research
   (v0.1-v0.3) was reasoned from publicly documented API shapes without live-docs access; the
   same caveat applies here with slightly higher stakes, since Zuora's Orders API has more
   surface area and more configuration-dependent behavior (workflow rules, custom settlement
   logic) than Stripe/Paddle's — several of this cycle's UNKNOWN determinations (early-
   termination fees, renewal-anchor interactions) are exactly the kind of thing that could, in
   principle, be resolved by a specific account/catalog configuration this research had no way
   to inspect. This is flagged explicitly rather than either asserted with false confidence or
   silently omitted.

## Direct answer: does SCQ describe a genuinely portable commercial-change contract across Stripe, Paddle, and Zuora?

**Yes, more convincingly than v0.3's answer for two providers — with one important
qualification.** The strongest evidence: NOTHING about SCQ's core data shapes
(`SubscriptionSnapshot`, `CommercialEffect`, `SubscriptionChangeProposal`,
`SubscriptionChangeReceipt`) had to change to accommodate Zuora, despite Zuora being a
genuinely different class of system (orders and contracts, not simple subscription objects).
The `UNKNOWN` sentinel introduced in v0.2/v0.3 for Stripe/Paddle's "this concept doesn't exist"
gaps turned out to be exactly the right vocabulary for Zuora's DIFFERENT kind of gap ("this
concept exists but isn't always derivable from a bare preview") — the schema didn't need to
distinguish those two kinds of not-knowing to remain honest, and didn't have to grow new fields
to say so. That is real evidence of portability: a contract designed against two Stripe/Paddle-
shaped providers absorbed a structurally different third provider's real capabilities
(a native version field, a real contract-term object, arbitrary future effective dates,
multi-action atomic orders) using its EXISTING vocabulary for the parts that mapped, and its
EXISTING escape hatch (`UNKNOWN`) for the parts that didn't — it did not require bespoke new
top-level concepts per provider.

**The qualification**: portability held for the REPORTING contract (can SCQ honestly describe
what each provider can and can't guarantee, in a shared vocabulary) but NOT for the ACTION
contract's expressiveness. Section "concepts that failed to normalize" above lists three real
Zuora capabilities (arbitrary future-dating, atomic multi-action orders, and the finer-grained
per-subscription-state term knowability) that are strictly RICHER than anything Stripe or
Paddle offer, and SCQ v0.4's four fixed actions and single-action-per-proposal shape cannot let
a caller reach any of them. This is a different, and arguably more important, finding than
v0.3's: v0.1-v0.3 asked "can SCQ avoid OVERSTATING what providers can do" and answered
increasingly well (yes, by v0.3/v0.4's capability-scoped EXACT). v0.4 additionally surfaces
"can SCQ avoid UNDERSTATING what a richer provider can do" — and the honest answer there is:
not yet, for at least these three capabilities. SCQ was NOT "only a useful abstraction for
simpler billing systems" in the sense of being WRONG about Zuora (it never claims something
false); it IS currently a NARROWER abstraction than Zuora's real capability surface, in ways
that would matter to a caller who specifically wants Zuora's stronger guarantees (e.g.
scheduling a future-dated change with confidence, or bundling several changes atomically).

## Recommendation: **MODIFY**

Not PROCEED — the three "concepts that failed to normalize" are not cosmetic. A caller
integrating specifically because they need Zuora's future-dating or atomic multi-action orders
would find SCQ v0.4 cannot express what they need, even though the underlying provider can
deliver it; shipping without at least documenting this loudly (as this section does) would
overstate the protocol's coverage of a system whose distinguishing features are exactly the
ones SCQ can't reach yet.

Not KILL — the core finding is strongly positive: SCQ's REPORTING vocabulary (the normalized
snapshot/effect/capability shapes) absorbed a structurally different, more complex provider
without requiring new top-level concepts, using mechanisms (`UNKNOWN`, `GuaranteeCoverage`'s
per-dimension split) that were already general enough or correctly anticipated by v0.3's own
recommendation to refine EXACT before adding a third provider. That is exactly the kind of
validation a "does this generalize" cycle is supposed to produce, and it came back positive on
the harder half of the question (can the schema describe reality honestly) even though it
surfaced a real gap on the other half (can the schema let a caller ask for everything a richer
provider offers).

Concrete direction for the next cycle, if pursued:
1. **Decide deliberately whether to extend `effectivePolicy` / add a `scheduledFor` field** to
   let a caller request an arbitrary future effective date — this is the single highest-value
   gap, since it's a real, common enterprise billing need (schedule a downgrade for next
   quarter, a plan change for a specific renewal date) that Zuora already supports natively and
   that SCQ currently cannot express at all, not even in REVALIDATE form.
2. **Do NOT add Chargebee/Zuora-adjacent providers or new SCQ actions yet**, per this cycle's
   explicit scope boundary — the priority is resolving whether the three "failed to normalize"
   concepts are worth schema investment BEFORE adding more providers that might each surface
   their own additional gaps, compounding the backlog rather than resolving it.
3. **Consider whether `quoteCapabilities`' per-action (not per-action-per-subscription-state)
   granularity is a permanent limitation to document, or worth a targeted refinement** — Test
   9e's tension (action-level UNKNOWN vs. a specific quote correctly resolving to a concrete
   value) is a real, load-bearing distinction a caller building routing logic on
   `getCapabilities()` alone would miss.
4. **If a compare-and-swap precondition is ever confirmed to exist on any of the three
   providers' real APIs** (this research could not verify its absence with full confidence for
   any of them, Zuora least of all given its configuration-dependent behavior), `ATOMIC` should
   be reconsidered for that specific provider — this cycle's BEST_EFFORT-for-all-three
   conclusion is the honest current-evidence answer, not a permanent architectural ceiling.

---
---

# SCQ v0.5 Research Findings — Chargebee Validation + Protocol Schema Changes

**Scope, exactly as specified**: only these protocol changes — `requestedEffectiveAt` (optional,
proposal-level), `action` replaced by `changes[]` (one or more changes per proposal),
quote-level `guaranteeCoverage` (authoritative for the specific proposal + subscription state),
provider-level `getCapabilities()` kept as coarse discovery only, and explicit
`multiChangeConsistency: "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED"` reporting for multi-change
commits. Then Chargebee added as provider #4, validated against the same required scenarios.
No other abstractions were added. No fifth provider was added, per the task's explicit
instruction.

All 54 tests pass (`npm test`) — up from v0.4's 36, with 10 new cross-provider protocol tests
(`test10-scq-v05.test.ts`) and 10 new Chargebee-specific tests (`test11-chargebee.test.ts`).
**Three genuine implementation bugs were found and fixed during this cycle**, all in the
multi-change composition logic, not glossed over:
1. Stripe, Paddle, and Chargebee's per-change resolution functions each independently looked up
   an item's CURRENT state from the ORIGINAL subscription every time, rather than from the
   running state of the batch — so a proposal like `[CHANGE_QUANTITY(item, 120),
   CHANGE_PLAN(item, "pro")]` targeting the SAME item silently lost the quantity change,
   because the plan-change step re-read the item's original quantity (100) instead of the
   quantity the first change in the same batch had just set (120). Caught directly by Test 10e
   failing with `100 !== 120`. Fixed by threading a `workingItems` map through the fold so each
   change sees the batch's cumulative state, not the pre-batch snapshot — implemented
   identically (same doc comment, same shape) in all three affected adapters.
2. The same bug, if left unfixed, would also have produced duplicate entries in the final
   `items[]` array sent to the provider when two changes targeted the same item — fixed as part
   of the same change by deriving the final items array from the folded `workingItems` map
   (one entry per item) rather than naively mapping over each change's individual result.
3. A test-authoring bug (not adapter code) in this cycle's own Test 10g asserted a bundled
   Zuora `CHANGE_QUANTITY + CANCEL(PERIOD_END)` order would leave `status: "canceled"`
   immediately — incorrect; `PERIOD_END` correctly schedules the cancellation (status stays
   `"active"`, `autoRenew` becomes `false`) exactly as the single-action CANCEL tests since
   v0.1 have always asserted. Fixed by correcting the test's expectation, not the adapter.

## What changed and why

- **`requestedEffectiveAt`** (`src/core/types.ts`): optional ISO-date string on the proposal.
  `enforceRequestedEffectiveAt()` (`scq-engine.ts`) is the single shared gate: providers that
  pass `canHonorFutureDate: false` (Stripe, Paddle) refuse any request more than ~1 day out
  with `UNSUPPORTED_CHANGE`, confirmed by Test 10a/10b; a near-"now" request is tolerated
  (Test 10c) rather than requiring exact millisecond equality, since that would be
  impractically brittle for real callers. Providers that pass `canHonorFutureDate: true`
  (Zuora, Chargebee) honor it via their real native scheduling primitives — Zuora's order
  `effectiveDate`, Chargebee's `effective_from` (Scheduled Changes) — confirmed end-to-end
  through the real adapter API for the first time in Test 9g/10d (Zuora) and Test 11d
  (Chargebee), closing the exact v0.4 "concept that failed to normalize" gap where this could
  only be demonstrated against the raw sim.
- **`changes: ChangeSpec[]` replaces `action` + flat fields**: `SubscriptionChangeProposal` is
  now `{ changes: ChangeSpec[] } & GuaranteeFields & { requestedEffectiveAt? }`, where
  `ChangeSpec` is semantically identical, per-variant, to v0.4's old proposal shape. A
  single-element array is behaviorally indistinguishable from the pre-v0.5 proposal (confirmed
  by Test 10h, an explicit regression check). This directly closes v0.4's "concepts that failed
  to normalize" #3: a caller can now express a genuine multi-change intent (e.g. quantity change
  + plan change, or — on Zuora — quantity change + cancellation) as ONE proposal instead of
  being structurally unable to ask for it.
- **`guaranteeCoverage` (quote-level, NOT provider-level)**: computed at `createChangeQuote`
  time against the ACTUAL proposal and ACTUAL subscription state, and is authoritative for that
  specific quote — `enforceGuaranteeRequest` now checks THIS field, not the coarse
  `getCapabilities()` report, when deciding whether to honor an overall EXACT request. This
  closes the exact tension v0.4's Test 9e left undocumented: Zuora's CANCEL termEffect is
  UNKNOWN at the coarse, action-level `getCapabilities()` report (correct — a committed-term
  subscription might exist), but for a SPECIFIC evergreen subscription's quote, the answer is
  fully knowable and now correctly resolves to EXACT — demonstrated end-to-end in the rewritten
  Test 9e ("v0.5 fix confirmed... the overall EXACT request succeeded end-to-end") and
  contrasted directly against the committed-term case in the new Test 9e2 (still correctly
  refused). `getCapabilities()` itself is UNCHANGED in shape and role — still coarse,
  provider-level, general-purpose discovery, exactly as the task specified it must remain.
- **`multiChangeConsistency: "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED"`**: computed by
  `computeMultiChangeConsistency()` (`scq-engine.ts`), which asks the adapter to resolve every
  UNORDERED PAIR of change actions in the batch via a `multiChangePairSupport(a, b)` function
  and takes the WEAKEST result across all pairs. A single-change proposal is always trivially
  `"ATOMIC"` (nothing to sequence). Critically, when `computeMultiChangeConsistency` resolves
  `"UNSUPPORTED"`, `enforceMultiChangeConsistency()` REFUSES the entire proposal with
  `UNSUPPORTED_CHANGE` at quote-creation time — the spec's explicit requirement that an
  unsupported bundle must be refused outright, not silently degraded into a partial,
  unrollback-able sequence of separate provider calls. Confirmed directly: Test 10f (Stripe)
  and Test 11f (Chargebee) both assert the refused proposal left the subscription completely
  untouched — not partially applied.
- **No other abstractions were added.** Per-change `guaranteeMode`/`acceptanceEnvelope` were
  considered (a caller might reasonably want different drift tolerance per change in a batch)
  and explicitly NOT added — see "concepts that failed to normalize" below for why this was a
  deliberate omission, not an oversight.

## The multi-change capability matrix (real, provider-specific finding)

This is the most concrete new finding of the cycle — `multiChangePairSupport` differs
genuinely across all four providers, and the difference is NOT symmetric in the way it might
be assumed to be:

| Provider | CHANGE_QUANTITY + CHANGE_PLAN/CADENCE together | Any change + CANCEL together |
|---|---|---|
| Stripe | **ATOMIC** — real `items[]` parameter on `subscriptions.update` accepts multiple item changes in one call | **UNSUPPORTED** — cancellation is a distinct parameter/call shape (`cancel_at_period_end` / DELETE), cannot share a call with an `items[]` update |
| Paddle | **ATOMIC** — real `items[]` full-replacement parameter on `PATCH /subscriptions/{id}` | **UNSUPPORTED** — same reasoning, cancellation is a distinct concept |
| Zuora | **ATOMIC** | **ATOMIC** — a single Zuora order can carry ANY combination of order actions (`UpdateProduct`, `RemoveProduct`, `AddProduct`, `CancelSubscription`) applied together as one atomic unit, confirmed directly in Test 9g/10g: a `CHANGE_QUANTITY + CANCEL` bundle committed as one order, one version bump, both effects applied |
| Chargebee | **ATOMIC** — real `update_for_items` full-item-list parameter | **UNSUPPORTED** — `cancel_for_items` is a genuinely separate endpoint, confirmed in Test 11f |

**Zuora is the only provider of the four where a caller can bundle a cancellation with another
change atomically.** This is a real, structural difference in what "an order" means on Zuora
(an arbitrary bundle of order actions) versus what "an update" means on the other three
(an item-list replacement, with cancellation always living outside that shape) — not a
modeling artifact of this research. `multiChangeConsistency` makes this queryable per-proposal
rather than requiring a caller to already know it from provider documentation.

## Chargebee capability matrix

| Capability | Chargebee | Contrast |
|---|---|---|
| **Maps to Snapshot → Quote → Commit** | **Yes, cleanly** — `GET /subscriptions/{id}` → `POST /estimates/update_subscription_for_items` (or `/estimates/cancel_subscription_for_items`) → `POST /subscriptions/{id}/update_for_items` (or `cancel_for_items`). Confirmed end-to-end for all four SCQ actions (Test 11a-11c). | Same three-call shape as Stripe/Paddle/Zuora — no new top-level SCQ concept was needed. |
| **immediateFinancialEffect / recurringFinancialEffect** | **EXACT for every action** — Chargebee's proration pivots on an explicit instant (now, captured/replayed, or a scheduled future `effective_from`), never ambient wall-clock-at-call-time. Same structural category as Zuora, not Stripe/Paddle. | Genuinely stronger than Stripe (which needs the `proration_date` workaround) and Paddle (which has no pin at all). |
| **termEffect, CHANGE_QUANTITY** | **EXACT** — a pure quantity change on an existing item never touches `contract_term`. | Same reasoning as Zuora's equivalent row. |
| **termEffect, CHANGE_PLAN/CHANGE_CADENCE** | **UNKNOWN** (coarse) — a bare item-price swap doesn't reliably surface contract_term interaction, same gap shape as Zuora's equivalent actions. | Same limitation, same reasoning as Zuora. |
| **termEffect, CANCEL — KEY CROSS-PROVIDER FINDING** | **EXACT at the quote level for BOTH evergreen AND committed-term subscriptions** (Test 11g, 11h) — Chargebee's cancellation estimate response, when a `contract_term` is present, deterministically computes an early-termination consequence (modeled here as a pro-rata charge for the remaining contracted value: $10,000.00 for ~10 months remaining on a $1,000.00/mo committed subscription in Test 11g — the simplified formula this sim uses; real Chargebee's actual early-termination math may differ in detail, but the STRUCTURAL claim — that the estimate response surfaces enough to compute it deterministically — is the finding, not the specific dollar figure). | **This is the sharpest asymmetry found in this cycle.** Zuora's equivalent case (Test 9f, 9e2) is UNKNOWN even at the quote level for a committed-term subscription, because Zuora's order preview alone does not reliably surface early-termination consequences (that logic can live in external workflow/settlement configuration). Chargebee's contract_term object is narrower in scope than Zuora's term structure but, where present, appears to be MORE self-contained — its estimate call surfaces the consequence directly. Both are honestly reported as they actually resolve; neither is "wrong." |
| **effectiveAt (requestedEffectiveAt support)** | **EXACT** — Chargebee's real Scheduled Changes mechanism (`effective_from` on `update_for_items`) accepts an arbitrary future timestamp and holds the change server-side until it arrives (Test 11d demonstrates this: the item does NOT change immediately in the commit receipt, only after simulated time advances past the requested date). | Same category as Zuora, genuinely different from Stripe/Paddle (no such concept at all). |
| **Multi-change bundling (non-CANCEL)** | **ATOMIC** — real `update_for_items` full-item-list parameter (Test 11e). | Same as Stripe/Paddle. |
| **Multi-change bundling (with CANCEL)** | **UNSUPPORTED** — `cancel_for_items` is a genuinely separate endpoint (Test 11f). | Same as Stripe/Paddle; the one point where Chargebee does NOT match Zuora's stronger capability. |
| **Native version / optimistic-concurrency field** | **Not confirmed to exist** (uncertainty flagged, not verified against live docs) — Chargebee subscriptions expose `updated_at`/timestamp-ish fields on some responses, but nothing documented as a monotonic version integer or usable compare-and-swap value. This adapter falls back to a synthetic content-hash fingerprint, same posture as Stripe/Paddle (Test 11i). | Contrast with Zuora, the only one of the four providers modeled with a confirmed real native version field. |
| **Atomic state-precondition + mutation** | **IMPOSSIBLE_TO_GUARANTEE (native)** — no compare-and-swap parameter on `update_for_items`/`cancel_for_items` as far as we are aware; `consistencyGuarantee` correctly reports `BEST_EFFORT`. TOCTOU race demonstrated directly in Test 11j: a concurrent write injected between the fingerprint check and the mutating call was silently clobbered, identical structural outcome to all three other providers. | Same finding as Stripe, Paddle, AND Zuora — the fourth data point confirming this is not specific to any one provider's API design, but appears to be a structural property of how these APIs are shaped (fingerprint/version read as a separate call from the mutating call, with no combined precondition parameter offered by any of the four). |

## Direct answers to the five primary research questions

1. **Can Chargebee map to the existing Snapshot → Quote → Commit model?** Yes, cleanly, with no
   schema changes needed beyond the three protocol changes this cycle already made for other
   reasons (Zuora's findings, not anything Chargebee-specific forced). `SubscriptionSnapshot`,
   `CommercialEffect`, and the receipt shape absorbed Chargebee's item-based subscription model,
   opt-in contract terms, and Scheduled Changes without new top-level fields.
2. **Can future-effective changes be normalized using `requestedEffectiveAt`?** Yes — confirmed
   end-to-end (Test 11d): a request 15 days out was accepted, the item's own state was
   confirmed unchanged immediately after commit (proving it was genuinely deferred, not
   silently applied early), and confirmed changed only after simulated time advanced past the
   requested date. This is the SAME field, with the SAME enforcement function, that Zuora uses
   — no Chargebee-specific field was needed.
3. **Can multi-change operations be represented without provider-specific fields?** Yes for the
   proposal/quote/receipt SHAPE (`changes[]`, `multiChangeConsistency` — both fully
   provider-neutral, confirmed by the `types.ts` provider-neutrality convention holding
   throughout this cycle). No for the underlying CAPABILITY itself: Chargebee's real API
   genuinely cannot bundle CANCEL with other changes atomically (Test 11f), a true fact about
   Chargebee that the neutral `multiChangeConsistency: "UNSUPPORTED"` value communicates
   honestly rather than hiding behind an artificial success.
4. **Does quote-level guaranteeCoverage accurately represent state-dependent capabilities?**
   Yes — and Chargebee provides the sharpest confirming evidence yet, because its correct
   quote-level answer for CANCEL's termEffect (EXACT for BOTH evergreen and committed-term
   subscriptions, Test 11h) is DIFFERENT from Zuora's correct quote-level answer for the
   structurally analogous case (EXACT only for evergreen). If `guaranteeCoverage` were computed
   generically instead of per-adapter/per-state, this real difference could not surface
   correctly — the field's value is precisely that it lets each adapter report its own honestly
   different answer for a state-dependent capability, rather than forcing one schema-level
   assumption across all providers.
5. **Does Chargebee provide atomic state-precondition + mutation, or does the same TOCTOU gap
   remain?** The gap remains — confirmed directly (Test 11j), same structural outcome
   (silent clobber, no conflict surfaced) as Stripe, Paddle, and Zuora. Chargebee does not
   appear to offer a native version field either (unlike Zuora), so unlike Zuora it does not
   even offer the STRONGER STALENESS DETECTION Zuora provides — Chargebee sits in the same
   bucket as Stripe/Paddle on both axes (detection AND atomicity), while Zuora is uniquely
   better on detection only. This is now a 4-provider data point, not a 3-provider one, for the
   claim that no compare-and-swap precondition mechanism was found on any of these APIs' real
   subscription-mutation surfaces.

## Concepts that failed to normalize (v0.5 additions)

Per the running convention of this research, documented explicitly rather than hidden:

1. **No per-change `guaranteeMode`/`acceptanceEnvelope`.** A caller bundling
   `[CHANGE_QUANTITY, CHANGE_PLAN]` might reasonably want EXACT for one and a looser REVALIDATE
   envelope for the other. v0.5's `changes[]` array shares ONE `guaranteeMode` and ONE
   `acceptanceEnvelope` across the whole batch (`computeCombinedCoverage` takes the WEAKEST
   per-dimension value across all changes). This was a deliberate, considered omission: the
   task's scope explicitly listed only four changes to make this cycle, and a per-change
   guarantee/envelope split would be a FIFTH new abstraction not on that list. Flagged here as
   a real limitation a caller with genuinely mixed-guarantee needs would hit, not solved this
   cycle.
2. **`multiChangeConsistency` is computed pairwise, not for the whole batch at once.** A batch
   of three-or-more changes could in principle have a capability that isn't reducible to
   pairwise checks (e.g. "any two of these three bundle fine, but all three together do not") —
   none of the four providers modeled here have such a shape as far as we could determine, so
   this wasn't exercised, but the `computeMultiChangeConsistency` design assumes pairwise
   composability holds, which is an assumption, not a verified fact about any provider's real
   API beyond two-item bundles.
3. **Chargebee's early-termination charge formula is a simplified model, not verified against
   real Chargebee behavior.** The STRUCTURAL claim (Chargebee's contract_term + cancel estimate
   surfaces a deterministic early-termination consequence) is the finding; the SPECIFIC formula
   used to compute the dollar amount in this sim (pro-rata remaining contract value) is an
   invented approximation for research purposes, explicitly flagged as such in
   chargebee-sim.ts, and should not be read as a claim about real Chargebee's actual
   early-termination pricing logic (which likely involves configurable rules this research had
   no way to verify).
4. **Chargebee's Scheduled Changes execution model is simplified.** Real Chargebee likely
   executes scheduled changes via an internal job/webhook mechanism with its own latency and
   failure modes; this sim's `applyDuePendingChanges()` (triggered synchronously on
   `advanceTimeSeconds`) is a minimal stand-in sufficient to test the REQUEST/ACCEPT/DEFER
   contract, not a claim about Chargebee's actual execution timing guarantees.

## Recommendation: **MODIFY**

Not PROCEED — two of the "concepts that failed to normalize" above (no per-change
guarantee/envelope; the pairwise-composability assumption in multi-change consistency) are
real limitations a sufficiently complex real-world caller would hit, and the Chargebee
early-termination formula is explicitly a research approximation, not a verified real-provider
behavior — shipping without disclosing that distinction would overstate confidence in one
specific capability row.

Not KILL — this cycle's core findings are strongly positive and, notably, ALL THREE protocol
changes were validated as genuinely load-bearing rather than speculative: `requestedEffectiveAt`
closed a real v0.4 gap (confirmed on two independent providers, Zuora and Chargebee, with the
identical mechanism); `changes[]` unlocked a real capability (Zuora's atomic CANCEL+other-change
bundling) that was previously unreachable through SCQ; and quote-level `guaranteeCoverage`
correctly produced DIFFERENT, both-correct answers for structurally analogous cases on two
different providers (Zuora's committed-term CANCEL: UNKNOWN; Chargebee's: EXACT) — proof the
field carries real information a provider-agnostic schema could not have hard-coded. A fourth
provider was absorbed with zero new top-level data concepts, only the guarantee-reporting
refinements this cycle's own task already called for.

Concrete direction for the next cycle, if pursued (not to be acted on without explicit
instruction, consistent with this cycle's "do not add a fifth provider" boundary):
1. **Do not add a fifth provider yet.** Per this task's explicit instruction, and because two
   of the four "concepts that failed to normalize" from THIS cycle (per-change guarantee
   granularity, pairwise-composability assumption) would compound with each additional
   provider rather than resolve — worth stabilizing the four-provider schema before widening
   further.
2. **If per-change guarantee granularity is ever pursued**, treat it as a deliberate, scoped
   addition (matching this cycle's own discipline of "make only these protocol changes") rather
   than an incidental side effect of some other feature.
3. **Verify the Chargebee early-termination and Scheduled-Changes execution models against real
   API documentation** before treating either as more than a structural placeholder — both are
   flagged explicitly above as approximations, not verified findings, unlike most of this
   research's other claims.

---
---

# SCQ v0.5-LIVE — Real Chargebee Test-Site Validation

**Scope**: replace v0.5's Chargebee-simulator assumptions with observed behavior from a real
Chargebee test site (Product Catalog v2, "items" response schema, confirmed via
`GET /configurations`), for the same five experiments the simulator cycle covered. Credentials
were supplied only as environment variables, read at call time, never printed or written to
any saved file (verified by grepping every saved artifact for the key string before and after
this section was written — clean both times). The API key's `test_` prefix confirmed test mode
before any mutating call was made. All raw requests/responses were saved sanitized (auth
removed by construction — `curl -u` never echoes credentials into a response body, and no
request body ever contained the key); 33 files total, referenced below by experiment.

Two objects were created and used for these experiments: `Azys2fVTYllJp1FQ0` (professional
plan + a per-unit "Data Compliance" add-on, used for CHANGE_QUANTITY/multi-change/TOCTOU) and
`AzZRAfVTYnsarxh` (evergreen professional plan only, used for cancellation). Both were
cancelled at the end of the session as cleanup; no persistent test-site state was left active
beyond two customer records.

## Experiment 1 — CHANGE_QUANTITY (per-unit add-on, 100 → 120 units)

- **Raw request** (estimate): `POST /estimates/update_subscription_for_items`,
  `subscription[id]`, `subscription_items[item_price_id][]`/`[quantity][]` for both the
  unchanged base plan and the changed add-on, `invoice_immediately=true`.
- **Raw response** (estimate): `invoice_estimate.total = 84000` (i.e. $840.00), one line item,
  `proration_mode: "delta"`, `pricing_model: "per_unit"`, `quantity: 20` (the DELTA, not the
  new total — the line item describes only the 20-unit increase, dated
  `date_from`=now, `date_to`=current_term_end).
- **Raw response** (`invoice_estimate` when `invoice_immediately=false`): entirely absent — the
  response only contains `unbilled_charge_estimates` in that mode, a differently-shaped object
  with the same dollar figures. **This is a real API behavior neither the simulator nor v0.5's
  design considered**: the shape of Chargebee's estimate response depends on the
  `invoice_immediately` flag, not just the proposal contents.
- **Real update**: `POST /subscriptions/{id}/update_for_items` with identical items, same
  `invoice_immediately=true`. Resulting `invoice.total = 84000` — **exact match to the
  estimate**, confirmed by direct comparison of the two JSON values, not by re-deriving from
  the simulator's proration formula.
- **Normalized SCQ object** (`CommercialEffect`, matching v0.5's shape):
  ```json
  { "immediate": { "charge": 84000, "net": 84000 },
    "recurring": { "resultingAmount": 508600, "currency": "usd" },
    "effectiveAt": "<estimate created_at>" }
  ```
  `resultingAmount` (508600 = $46.00 flat plan + 120 × $42.00 add-on) was **not present in any
  Chargebee response** — it had to be computed client-side from the caller's own known item
  prices and the proposal's requested quantities, exactly as v0.5's adapter design already does
  (it never reads `resultingAmount` off the estimate; it computes it from
  `ITEM_PRICE_CATALOG` × requested quantity). This is a genuine confirmation, not a new finding
  forcing a change: the simulator's design already matched real behavior here by not assuming
  the provider would hand back a resulting-total figure.
- **Observed committed state**: `subscription_items[1].amount = 504000` post-commit — this is
  the FULL recurring line total (120 × 4200), not a delta, confirming `subscription_items[].amount`
  and `invoice.line_items[].amount` are semantically different fields (full recurring value vs.
  prorated delta) that must not be conflated when building `CommercialEffect.recurring` vs.
  `.immediate`.
- **Differences vs. simulator**: **immediateFinancialEffect: EXACT — CONFIRMED**, no discrepancy
  in the number itself. The only real discrepancy is structural (see above): the simulator's
  `OrderPreviewResult`-equivalent shape assumed a single unified preview object; real Chargebee
  splits this across `invoice_estimate` (only when `invoice_immediately=true`) vs.
  `unbilled_charge_estimates` (otherwise), and never returns a resulting recurring total at all.
  **Schema implication: none required** — v0.5's adapter design already avoided depending on a
  field that doesn't exist, so no `types.ts` change is needed; this is confirmation, not a fix.

## Experiment 2 — requestedEffectiveAt (future scheduling)

The user's mid-session correction is itself a finding: **Chargebee's own current guidance is
to prefer Ramps over ad-hoc future-dated `effective_from`/`end_of_term` scheduling where
applicable** — noted here as told, not independently re-derived, since verifying Chargebee's
product-guidance stance was out of scope for API experimentation. Two distinct real scheduling
mechanisms were found and tested, which is itself the headline discrepancy from the simulator
(which modeled only one, `effective_from`):

1. **`effective_from` on `update_for_items`**: NOT independently re-tested end-to-end with a
   future timestamp in this live cycle (time constraints after the endpoint-correction
   redirect) — the mechanism's existence and the `has_scheduled_changes` / `changes_scheduled_at`
   response fields were confirmed via mechanism 2 below, which surfaces the identical response
   shape. **Full separate verification of `effective_from` specifically is marked
   `UNVERIFIED`** — the closely related `end_of_term` mechanism was verified instead (see next
   point), and the two are structurally similar in the response but were not both directly
   exercised with distinct raw request/response pairs this session.
2. **`end_of_term=true` on `update_for_items`** (discovered mid-session, not anticipated by the
   simulator or v0.5's design at all): applying an item-quantity change with `end_of_term=true`
   does NOT change `subscription_items` immediately; instead it sets
   `has_scheduled_changes: true` and `changes_scheduled_at: <current_term_end>`, confirmed via
   `POST /subscriptions/{id}/retrieve_with_scheduled_changes`, which showed the pending quantity
   (150) held separately from the live `subscription_items` (still 140). This is a **second,
   real, distinct deferred-application mechanism** Chargebee exposes beyond arbitrary-timestamp
   `effective_from` — one tied to the current term boundary specifically (conceptually closer to
   Stripe/Paddle's period-end semantics than to Zuora's arbitrary-date orders).
   **Schema implication**: v0.5's `requestedEffectiveAt` field is a single ISO-date value and
   cannot distinguish "schedule for this arbitrary date" from "schedule for the current term's
   natural end" — on Chargebee these are two different real parameters
   (`effective_from` vs. `end_of_term`) that a caller might deliberately choose between (e.g.
   for billing-alignment reasons), and v0.5's schema collapses that choice. **This is a genuine
   new "concept that failed to normalize," found only by real API testing, not by the
   simulator.**
3. **Cleanup verification**: `POST /subscriptions/{id}/remove_scheduled_changes` successfully
   cleared the pending change (confirmed via `has_scheduled_changes: false` after) — Chargebee
   exposes an explicit real endpoint for retracting a scheduled change before it executes, which
   the simulator does not model at all (no retraction concept exists in `chargebee-sim.ts`).

## Experiment 3 — Committed-term CANCEL

**`committed-term CANCEL = UNVERIFIED`**
**Reason: Contract Terms feature not enabled on test site.**

Confirmed directly: `POST /customers/{id}/subscription_for_items` with
`contract_term[action_at_term_end]`/`[billing_cycle]`/`[cancellation_cutoff_period]` parameters
returned `400 invalid_request` — `"action_at_term_end : You need to enable Contract Terms
feature to create contract terms"`. A scan of all 11 subscriptions present on the test site
(the 5 pre-existing demo records plus this session's own test records) found none with a
`contract_term` key present at all. Enabling this feature is an account-level action outside
the Subscriptions/Estimates API surface (no endpoint was found or attempted to toggle it, per
the explicit instruction not to attempt this experiment on this site). **No live evidence
exists for or against the simulator's `contract_term_cancel_option` assumptions, the
deterministic-early-termination-fee claim, or the Chargebee-vs-Zuora asymmetry the simulator
asserted for this case. That entire row of the v0.5 capability matrix reverts to `UNVERIFIED`
and must not be read as confirmed by this cycle.**

What WAS verified live, for the evergreen (no contract term) case only, using the
user-specified correct endpoint:

- **`POST /subscriptions/{id}/cancel_subscription_for_items_estimate`, `cancel_option=immediately`**:
  raw response `{"subscription_estimate": {"status": "cancelled", ...}, "credit_note_estimates": []}`
  — no fee, no credit, resulting status `cancelled`.
- **Same endpoint, `cancel_option=end_of_term`**: raw response
  `{"subscription_estimate": {"status": "non_renewing", ...}, "credit_note_estimates": []}` —
  no fee, no credit, resulting status `non_renewing` (matches SCQ's `PERIOD_END` mapping
  exactly).
- **Real commit**: `POST /subscriptions/{id}/cancel_for_items` with `end_of_term=true` produced
  `status: "non_renewing"` — **exact match to the `end_of_term` estimate above**, confirmed by
  direct string comparison, not inferred.
- **Differences vs. simulator for the evergreen case**: none found. The simulator's evergreen
  CANCEL modeling (no fee, deterministic status mapping, estimate/commit agreement) is
  confirmed for the one case this test site could actually exercise. This does NOT confirm or
  extend to the committed-term row, which remains `UNVERIFIED` per the reason stated above.

## Experiment 4 — TOCTOU

- **Quote**: `POST /estimates/update_subscription_for_items` (120 → 130 units), captured
  `amount_due: 42000` and the subscription's `resource_version` at that moment
  (`1787889009713`).
- **Read**: `GET /subscriptions/{id}` — confirmed same `resource_version`.
- **Out-of-band mutation**: a separate `POST /subscriptions/{id}/update_for_items` (120 → 125
  units, bypassing the "SCQ" flow entirely) — succeeded, new `resource_version: 1787889058586`.
- **SCQ commit attempt**: the client-side version comparison (`quoted_version !=
  current_version`) is exactly what would trigger `QUOTE_STALE` in the real adapter and prevent
  any further API call — this was confirmed as arithmetic on the two captured integers, not a
  new API call, since the adapter's actual defense is entirely client-side by construction.
- **Direct test of whether Chargebee itself offers ANY backstop**: a further `POST
  /subscriptions/{id}/update_for_items` (the original stale 130-quantity request) was sent WITH
  an `If-Match: "<quoted resource_version>"` header attached, to see whether Chargebee's API
  honors any conditional-request mechanism if the client-side check were skipped or absent.
  **Result: HTTP 200, mutation applied unconditionally, `If-Match` header completely ignored.**
  The prior out-of-band value (125) was silently overwritten by the stale request's value (130)
  with zero conflict signal from the API — no error, no warning field, nothing.
- **Confirmed finding**: Chargebee exposes **no atomic version/precondition mechanism** on
  `update_for_items`. `resource_version` is available for CLIENT-SIDE staleness detection only
  (and only if the client actually checks it before mutating) — it is not a server-enforced
  precondition value in any way this API accepts. This is an exact, direct confirmation of the
  simulator's `consistencyGuarantee: "BEST_EFFORT"` conclusion — not an assumption anymore, an
  observed fact.
- **Additional real finding not in the simulator**: `resource_version` was directly confirmed
  (via `updated_at * 1000` arithmetic, `1787889009 * 1000 = 1787889009000` vs. the actual
  `1787889009713`) to be **`updated_at` restated at millisecond precision**, not an independent
  monotonic counter. It changes on every mutation (confirmed across all of this session's real
  update/cancel calls), so it works as a fingerprint-equivalent, but it is structurally
  different from — and weaker than — Zuora's small monotonic integer: two mutations landing
  within the same millisecond would produce identical `resource_version` values (a theoretical
  collision window the simulator's synthetic content-hash also shares, for a different reason —
  neither is a true compare-and-swap token). **Schema implication: none required** — v0.5
  already modeled Chargebee's version as a synthetic-fingerprint-equivalent, not a
  Zuora-style native counter, and that classification is now directly confirmed rather than
  assumed.

## Experiment 5 — Multi-change

- **Quantity + plan in one real call**: `POST /subscriptions/{id}/update_for_items` with
  `subscription_items` containing BOTH the new plan (`cbdemo_business-suite-monthly`, replacing
  `cbdemo_professional-suite-monthly`) and the new add-on quantity (140) in the same request.
  **Estimate total: $515.99** ($95.99 plan-swap proration + $420.00 quantity-increase
  proration, two separate line items in one `invoice_estimate`). **Committed invoice total:
  $515.99 — exact match.** `resource_version` bumped exactly once (one call, one version
  change) — confirms this genuinely applies as one atomic operation, not two sequential ones.
  **Directly confirms the simulator's `ATOMIC` classification for this pair, with matching
  numbers, not just matching classification.**
- **CANCEL + another mutation in one call**: two real attempts were made to see how the actual
  API responds to a bundling attempt, since the simulator's `UNSUPPORTED` classification was an
  inference from separate-endpoint reasoning, not a tested rejection:
  1. `POST /subscriptions/{id}/update_for_items` with a quantity change AND extra params
     (`cancel_reason`, `end_of_term=true`) appended to the same call. Result: the quantity
     change was NOT applied immediately; `end_of_term=true` was instead interpreted as ITS OWN
     real meaning on this endpoint (schedule the item change for term-end — see Experiment 2),
     and `cancel_reason` was silently ignored as an unrecognized parameter. **No cancellation
     occurred; the subscription remained `active` throughout.**
  2. `POST /subscriptions/{id}/cancel_for_items` with an embedded `subscription_items`
     quantity-change parameter appended. Result: HTTP 200, cancellation applied
     (`status: "non_renewing"`), but the quantity-change parameter was **silently ignored** —
     the item quantity was unchanged after the call.
  - **Confirmed finding**: Chargebee's real API does not reject these malformed/bundled
    requests with an error — it silently drops the parameters it doesn't recognize for that
    endpoint and applies only the ones it does. **This is a sharper and more important finding
    than the simulator's `UNSUPPORTED` alone conveys**: a naive integration that assumed
    bundling worked because it got an HTTP 200 with no error field would silently lose the
    non-cancel half of its intended change. SCQ's `enforceMultiChangeConsistency()` refusing
    the proposal OUTRIGHT before making any API call (as v0.5 already does) is validated as the
    correct behavior, and is now validated against a REAL silent-partial-application failure
    mode, not just a hypothetical one.

## Discrepancies vs. simulator (summary)

| # | Finding | Simulator said | Real API shows | Confirmed / Changed |
|---|---|---|---|---|
| 1 | Estimate response shape | One unified preview object | Splits across `invoice_estimate` (only if `invoice_immediately=true`) vs. `unbilled_charge_estimates`; never includes a resulting recurring total | **New structural detail, no schema change needed** (adapter design already didn't depend on the missing field) |
| 2 | `subscription_items[].amount` semantics | Not modeled at this granularity | Full recurring line value, NOT the invoice delta — a real trap for a naive implementation | **New finding — adapters must be careful not to conflate the two amount fields; no v0.5 schema change needed since `CommercialEffect` already separates `immediate` and `recurring`** |
| 3 | Scheduling mechanisms | Only `effective_from` modeled | TWO real mechanisms exist: `effective_from` (arbitrary date) AND `end_of_term=true` (term-boundary-relative); only the latter was directly verified this session | **Confirmed `requestedEffectiveAt` closes A gap, but not necessarily the RIGHT one for callers who specifically want term-boundary alignment — schema implication below** |
| 4 | Committed-term CANCEL | EXACT for both evergreen and committed-term (contract_term present) | Evergreen case confirmed exactly as simulated; **committed-term case UNVERIFIED — Contract Terms feature unavailable on this site** | **Simulator's committed-term claim is NEITHER confirmed nor refuted — must not be treated as validated** |
| 5 | `resource_version` nature | Modeled as opaque fingerprint-equivalent (correct posture, not asserted to be a real counter) | Confirmed to be `updated_at` at millisecond precision — not independently monotonic, theoretically collision-prone within the same millisecond | **Confirmed correct classification (fingerprint-equivalent, not a native counter); no schema change** |
| 6 | Atomic precondition/compare-and-swap | Assumed absent (uncertainty flagged) | **Directly tested and confirmed absent** — an `If-Match` header was silently ignored, stale mutation applied unconditionally | **Assumption promoted to confirmed fact** |
| 7 | Multi-change (quantity+plan) | ATOMIC | Confirmed ATOMIC, numbers matched exactly (estimate $515.99 = committed $515.99, single resource_version bump) | **Confirmed exactly** |
| 8 | Multi-change (CANCEL + other) | UNSUPPORTED | Confirmed — but the FAILURE MODE is silent partial application, not a rejected request, which is more dangerous than "unsupported" alone conveys | **Confirmed classification, sharper failure-mode detail added** |

## Updated capability matrix (Chargebee row — real observations only)

| Capability | Chargebee (v0.5-LIVE, real) | Confidence |
|---|---|---|
| Maps to Snapshot → Quote → Commit | **Yes, confirmed** — `GET /subscriptions/{id}` → `POST /estimates/update_subscription_for_items` → `POST /subscriptions/{id}/update_for_items`, numbers matched exactly | Confirmed |
| immediateFinancialEffect (CHANGE_QUANTITY) | **EXACT, confirmed** — estimate and commit produced identical $840.00 | Confirmed |
| recurringFinancialEffect | **EXACT, but client-computed** — Chargebee never returns a resulting-recurring-total field; the adapter must compute it itself from known prices, which is what v0.5 already does | Confirmed (no field exists to double-check against, so "EXACT" here means "the client's own math," not "the provider confirmed it") |
| effectiveAt / requestedEffectiveAt | **Partially confirmed** — `end_of_term` mechanism directly verified (scheduled, held separately, retractable); `effective_from` arbitrary-date mechanism NOT independently re-verified this session | `end_of_term`: Confirmed. `effective_from`: **UNVERIFIED this session** (previously only simulator-modeled) |
| termEffect, CHANGE_QUANTITY | Not directly re-tested this session (no term-field interaction expected or seen in any response) | UNVERIFIED this session (simulator's EXACT claim not contradicted, but not independently re-confirmed either) |
| termEffect, CANCEL — evergreen | **EXACT, confirmed** — deterministic status mapping (`immediately`→cancelled, `end_of_term`→non_renewing), no fee, estimate matched commit | Confirmed |
| termEffect, CANCEL — committed term | **UNVERIFIED — Contract Terms feature not enabled on test site** | **UNVERIFIED, not simulated** |
| Native version/optimistic-concurrency field | **Confirmed absent** — `resource_version` is `updated_at` at ms precision, not an independent counter | Confirmed |
| Atomic state-precondition + mutation | **Confirmed absent** — `If-Match` header silently ignored, stale write applied unconditionally over a genuine concurrent write | Confirmed |
| Multi-change (quantity+plan) | **ATOMIC, confirmed** — one call, one version bump, estimate matched commit exactly | Confirmed |
| Multi-change (CANCEL + other) | **UNSUPPORTED, confirmed** — and the real failure mode is SILENT PARTIAL APPLICATION (HTTP 200, no error, only the recognized half of the request applied), not a rejection | Confirmed, with an added severity detail |

## Schema implications

1. **No SCQ type changes are required by anything confirmed this session.** Every real
   discrepancy found (estimate response shape, `amount` field semantics, `resource_version`
   nature) was already correctly anticipated by v0.5's adapter design not depending on the
   fields/guarantees that turned out to be missing or differently-shaped. This is a genuinely
   positive result: the schema's caution (deriving `recurringAmount` client-side rather than
   trusting a provider field, treating `resource_version` as a fingerprint rather than a
   counter) turned out to match reality exactly.
2. **One real gap was found that v0.5's schema does not express**: `requestedEffectiveAt` is a
   single ISO-date field and cannot distinguish "an arbitrary caller-chosen future date"
   (Chargebee's `effective_from`) from "the current billing term's natural end" (Chargebee's
   `end_of_term=true`, and structurally similar to Stripe/Paddle's `PERIOD_END` semantics for
   CANCEL specifically, but here available for CHANGE_QUANTITY/CHANGE_PLAN too, which Stripe/
   Paddle do not support at all for non-CANCEL actions). This is a genuine "concept that failed
   to normalize," discovered only through live testing, and is flagged for the next cycle
   rather than fixed now (per the "only these experiments" scope boundary for this cycle).
3. **Committed-term CANCEL remains entirely unvalidated.** The v0.5 simulator cycle's specific
   claim — that Chargebee's contract-term cancel estimate deterministically resolves an
   early-termination charge where Zuora's equivalent does not — is NEITHER confirmed NOR
   refuted by this session. It must be treated as an untested hypothesis from a simulator, not
   a validated finding, until a site with Contract Terms enabled can be tested.

## Direct answer: did real Chargebee behavior validate the assumptions that make SCQ portable across four providers?

**Mostly yes, with one confirmed gap and one major unresolved unknown.** Every assumption that
COULD be tested against this site was either confirmed exactly (financial estimate-to-commit
matching, ATOMIC multi-change bundling, UNSUPPORTED CANCEL-bundling, absence of a native
version field, absence of any compare-and-swap mechanism) or refined with additional real
detail without requiring a schema change (the two amount-field semantics, the split estimate
response shape). The one confirmed real gap — `requestedEffectiveAt` conflating two distinct
Chargebee scheduling mechanisms — is a genuine, newly-discovered limitation of the v0.5 schema,
not a simulator error. The one major unresolved item — committed-term CANCEL — is the specific
claim this research previously made the strongest, most novel argument around (the
Chargebee-vs-Zuora asymmetry), and it is now explicitly `UNVERIFIED`, not confirmed, pending a
test site with Contract Terms enabled.

## Recommendation: **MODIFY**

Not PROCEED — the committed-term CANCEL claim, which was the single most distinctive Chargebee
finding from the simulator cycle, is unverified against real behavior and must not be relied
upon; and the newly-discovered `effective_from` vs. `end_of_term` distinction is a real schema
gap, not yet addressed.

Not KILL — every assumption that could actually be tested against a real site was confirmed,
including the two most safety-critical ones (no atomic precondition mechanism; multi-change
CANCEL-bundling fails via silent partial application, which SCQ's outright-refusal behavior
correctly prevents). The schema required zero changes for anything confirmed this session,
which is strong evidence the design decisions made without live access were sound, not lucky.

Concrete direction for the next cycle, if pursued:
1. **Obtain a Chargebee test site with Contract Terms enabled** and re-run Experiment 3 in
   full before treating the committed-term CANCEL row as anything other than `UNVERIFIED`.
2. **Independently verify `effective_from` end-to-end** (this session verified `end_of_term`
   directly but not `effective_from` with a fresh, isolated raw request/response pair).
3. **Consider whether `requestedEffectiveAt` needs a companion enum** (e.g. an optional
   `effectiveAtBasis: "SPECIFIC_DATE" | "TERM_END"`) to let a caller express Chargebee's
   real distinction — only if a second provider is found to have the same two-mechanism split,
   per this research's standing discipline of not adding a dimension for one provider alone.

---

# v0.6 — Protocol Freeze Candidate

**Primary question**: Is the core SCQ model now stable enough to freeze for an external
protocol review?

## Scope of this cycle

No providers were added (still Stripe, Paddle, Zuora, Chargebee). Per the cycle's explicit
scope, exactly these changes were made:

1. Replaced `requestedEffectiveAt?: string` (and the inconsistently-present per-`ChangeSpec`
   `effectivePolicy` field) with a single required, closed-union `effectiveIntent:
   EffectiveIntent` on the proposal (`{type:"IMMEDIATE"} | {type:"TERM_END"} |
   {type:"DATE";at:string}`). Every adapter now reports `supportedEffectiveIntents` per action
   via a new `ActionCapabilities` wrapper around `GuaranteeCoverage`, and refuses unsupported
   intents before any preview call via a new `enforceEffectiveIntent` engine function.
2. Preserved without modification: quote-level `GuaranteeCoverage`; `REVALIDATE` as default;
   `quotedEffect`/`committedEffect` receipt fields; `ConsistencyGuarantee: BEST_EFFORT |
   ATOMIC`; `MultiChangeConsistency`; explicit `UNKNOWN` for undeterminable term effects.
3. Added a new normative rule against silent partial execution: if SCQ accepts a multi-change
   proposal, an adapter MUST NOT submit it if the provider might silently apply only a subset.
   A new error code, `UNSUPPORTED_CHANGE_SET`, and a new engine function,
   `enforceNoPartialExecutionRisk`, exist specifically to force this refusal before any
   mutating call, motivated directly by the v0.5-LIVE finding that Chargebee's
   `update_for_items`/`cancel_for_items` endpoints silently ignore unrecognized parameters and
   still return HTTP 200.
4. **Corrected, not just re-labeled, the Chargebee committed-term CANCEL claim.** v0.5's
   simulator asserted `guaranteeCoverage.termEffect: "EXACT"` for a Chargebee subscription
   under a committed term — described at the time as a genuine capability advantage over
   Zuora's equivalent (UNKNOWN) case. The v0.5-LIVE cycle attempted to validate this against a
   real Chargebee test site and could not (Contract Terms was not enabled on that site;
   `contract_term` creation was rejected outright with `400 invalid_request`), and marked the
   finding `UNVERIFIED` in that cycle's `research-findings.md` section without yet correcting
   the running code. **This cycle closes that gap**: `chargebee-adapter.ts`'s
   `quoteLevelCancelTermCoverage` function now returns `"UNKNOWN"` (not `"EXACT"`) whenever the
   subscription carries a `contractTerm`, with an extensive doc comment narrating exactly why
   the prior value was wrong and unverified. Two existing tests (Test 11g, Test 11h) that had
   asserted the retracted claim were rewritten to assert the correct, honest behavior instead
   of being deleted — the retraction itself is now a first-class, checked assertion (see
   `conformance.md` §6.9), not a silently-vanished test.
5. Converted the existing 9-file, 54-case test suite into a draft conformance suite —
   `conformance.md` maps every normative rule to the specific test(s) that validate it across
   all four providers, and explicitly calls out where suite coverage is thinner than the rule
   (e.g. the no-adapter-lock source scan currently only covers Stripe/Paddle; no adapter can
   currently reach the new `UNSUPPORTED_CHANGE_SET` path end-to-end, since none of the four
   constructs a request shape that risks it).
6. Produced `scq-v0.6-spec.md` (normative specification), `conformance.md` (test mapping), the
   updated capability matrix below, and the unresolved-issues list below.

## Schema diff (v0.5 → v0.6)

See `scq-v0.6-spec.md` §8 for the full table. Summary:

| Area | v0.5 | v0.6 |
|---|---|---|
| Effective timing | `requestedEffectiveAt?: string`; inconsistent `effectivePolicy` per-change | Single required `effectiveIntent: EffectiveIntent` (proposal-level only) |
| Capability shape | `Partial<Record<ChangeAction, GuaranteeCoverage>>` | `Partial<Record<ChangeAction, ActionCapabilities>>` (adds `supportedEffectiveIntents`) |
| Error codes | — | + `UNSUPPORTED_CHANGE_SET` |
| Chargebee committed-term CANCEL | `termEffect: "EXACT"` (never live-verified) | `termEffect: "UNKNOWN"` (retracted, explicitly UNVERIFIED) |
| Everything else | — | **Unchanged.** |

No provider added or removed. No change action added or removed. This is the smallest schema
diff of any cycle since v0.3 — a deliberate signal that the core model has largely stopped
needing new dimensions, not evidence that no more testing was done (four adapters' worth of
migration work and a full conformance-suite pass happened this cycle without requiring new
schema surface).

## Normative rules added

See `scq-v0.6-spec.md` §6, rules 6.7–6.9 specifically (6.1–6.6 restate prior cycles' rules
for one-document completeness):

- **6.7**: `EffectiveIntent` MUST be validated against `supportedEffectiveIntents` before any
  provider call.
- **6.8**: no adapter may submit a multi-change proposal that risks the provider silently
  applying only a subset — refuse with `UNSUPPORTED_CHANGE_SET` before mutation instead.
- **6.9**: Chargebee committed-term CANCEL MUST report `termEffect: "UNKNOWN"`.

## Conformance results

All 54 test cases across the 9 test files (test1, test3–test11; there has never been a
test2 file in this suite's numbering) pass after the full v0.6 schema migration, including the
two Chargebee tests rewritten under rule 6.9. Full rule-to-test mapping, and the suite-coverage
gaps found while building that mapping (G-1 through G-4 in `conformance.md`), are in
`conformance.md`. None of the coverage gaps found represent a discovered-and-unfixed defect —
each is an absence of a specific positive/negative test, most caused by no reference provider
currently exhibiting the exact edge behavior a fully exhaustive suite would want to check
(e.g. no provider refuses `TERM_END`, so that refusal path has no live test case to anchor to).

## Updated capability matrix (v0.6, quote-level authoritative values shown; coarse
provider-level values in parentheses where they diverge)

| Action | Stripe | Paddle | Zuora | Chargebee |
|---|---|---|---|---|
| CHANGE_QUANTITY — immediate/recurring financial | EXACT | REVALIDATE | EXACT | EXACT |
| CHANGE_QUANTITY — termEffect | UNKNOWN | UNKNOWN | EXACT | UNKNOWN |
| CHANGE_QUANTITY — effectiveAt | EXACT | EXACT | EXACT | EXACT |
| CHANGE_QUANTITY — supportedEffectiveIntents | IMMEDIATE | IMMEDIATE | IMMEDIATE, TERM_END, DATE | IMMEDIATE, TERM_END, DATE |
| CHANGE_PLAN / CHANGE_CADENCE — financial | EXACT | REVALIDATE | EXACT | EXACT |
| CHANGE_PLAN / CHANGE_CADENCE — termEffect | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| CHANGE_PLAN / CHANGE_CADENCE — supportedEffectiveIntents | IMMEDIATE | IMMEDIATE | IMMEDIATE, TERM_END, DATE | IMMEDIATE, TERM_END, DATE |
| CANCEL — financial | EXACT | EXACT | EXACT | EXACT |
| CANCEL — termEffect (evergreen subscription, quote-level) | EXACT | EXACT | EXACT | EXACT |
| CANCEL — termEffect (committed-term subscription, quote-level) | n/a (no committed-term concept) | n/a | UNKNOWN | **UNKNOWN (v0.6 corrected; was EXACT, UNVERIFIED)** |
| CANCEL — supportedEffectiveIntents | IMMEDIATE, TERM_END | IMMEDIATE, TERM_END | IMMEDIATE, TERM_END, DATE | IMMEDIATE, TERM_END, DATE |
| ConsistencyGuarantee | BEST_EFFORT | BEST_EFFORT | BEST_EFFORT (real version field; DETECTION only, not ATOMICITY) | BEST_EFFORT |
| Native version/fingerprint | synthetic fingerprint | synthetic fingerprint | real monotonic integer | synthetic content hash (`resource_version` confirmed live to equal `updated_at` restated) |
| Multi-change (quantity+plan) | ATOMIC | ATOMIC | ATOMIC | ATOMIC |
| Multi-change (CANCEL + other) | UNSUPPORTED | UNSUPPORTED | ATOMIC (unique to Zuora) | UNSUPPORTED |
| Silent-partial-application risk reachable through current adapter code | No | No | No | No (endpoint-level risk confirmed live; adapter never constructs the triggering request shape) |

## Unresolved blockers

Full detail in `scq-v0.6-spec.md` §9 (U-1 through U-5) and `conformance.md` "Unresolved / Known
Gaps" (G-1 through G-4). None are blocking for external protocol review; all are honestly
marked UNKNOWN/UNVERIFIED in the running code and type system rather than papered over:

1. **Committed-term CANCEL on Chargebee remains UNVERIFIED** against real API behavior (no
   test site with Contract Terms enabled has been available). This cycle's correction makes
   the code and tests honest about that; it does not resolve the underlying unknown.
2. **No provider has ever reported `ConsistencyGuarantee: "ATOMIC"`.** The type retains the
   value for a hypothetical future provider with a real compare-and-swap precondition; as of
   v0.6, across four providers and one live-API validation, this remains purely theoretical.
3. **`effectiveIntent` is proposal-level, not per-change** — a multi-change proposal cannot
   request different effective timing for different changes within itself. No real provider
   forced this to be added this cycle (per the "do not invent dimensions" discipline), but it
   is a known modeling ceiling.
4. **`UNSUPPORTED_CHANGE_SET` has no adapter code path that currently reaches it end-to-end** —
   all four adapters' call construction happens to avoid the failure mode it guards against.
   The rule and error code exist as a forward guard, verified only by manual per-adapter
   reasoning this cycle, not by an automated test that actually triggers it.
5. **Zuora's CHANGE_CADENCE term-interaction gap** (documented since v0.4) remains open and
   unmodeled.

## Recommendation: **FREEZE**

The core lifecycle (`getSubscription` → `createChangeQuote` → `commitChangeQuote`), the
guarantee-mode model (EXACT/REVALIDATE with per-dimension `GuaranteeCoverage`), the
quote-level-vs-provider-level capability split, and the multi-change consistency model have now
survived six schema-affecting cycles across four genuinely different billing providers plus one
live-API validation pass, with this cycle requiring the smallest schema diff of any cycle since
v0.3 (one field replaced, one wrapper type added, one error code added) while still resolving a
real, previously-uncorrected accuracy gap (Chargebee committed-term CANCEL).

This is FREEZE, not PROCEED, because "PROCEED" implies continuing to actively evolve the
protocol in-repo, whereas the explicit ask this cycle was to determine readiness for an
EXTERNAL review — a different kind of checkpoint. It is not KILL: nothing discovered this
cycle, or in any prior cycle, falsified the core model; every correction found (this cycle's
Chargebee retraction included) was absorbed as a refinement of an existing dimension, never as
evidence the dimension itself was wrong. The five unresolved blockers above are exactly the
right shape of open questions to hand to an external reviewer — each has an honest UNKNOWN/
UNVERIFIED marker in running, tested code, not an invented answer or a silently-dropped test.

---

# v0.6.1 — Standards-Hardening Cycle

**Scope constraint honored**: no providers, actions, or major schema concepts were added. Every
change below is either a wording correction, a clarification made normative, or a targeted
addition (one receipt field, two engine functions, one internal store field) directly required
by one of the six numbered issues this cycle was scoped to fix.

## 1. EXACT wording narrowed

Prior cycles' prose ("the commit is guaranteed to reproduce the quoted commercial effect
exactly") could be read as a whole-invoice guarantee. It never was one — every adapter's EXACT
mechanism (Stripe's `proration_date` replay, Zuora's/Chargebee's effective-date-pinned
order/estimate math) has only ever pinned the specific `GuaranteeCoverage` dimensions it
computes, never tax, discounts, or currency-conversion effects, none of which
`CommercialEffect` even models as a field. `types.ts`'s `GuaranteeMode` doc comment and
`scq-v0.6.1-spec.md` §4.1 now state this explicitly: EXACT on a dimension guarantees only that
dimension. No adapter code changed — this is a wording-only correction, and no test was needed
beyond the existing EXACT-scoping tests (8a/8b/9a/11a-b), which already only ever asserted
per-dimension values, never a whole-invoice claim.

## 2. REVALIDATE clarified

Three clarifications added to `scq-v0.6.1-spec.md` §4.2, one of which required a genuine
(minimal) implementation addition:

- The `AcceptanceEnvelope` is enforced against the **last pre-mutation preview** — this was
  already every adapter's actual behavior (see each `commitChangeQuote`'s "Order per spec:
  re-preview -> evaluate acceptance envelope -> mutate" comment, present since v0.2); now stated
  as explicit spec text.
- With `ConsistencyGuarantee: BEST_EFFORT` (true for all four providers, confirmed live for
  Chargebee in v0.5-LIVE), SCQ **cannot guarantee** a concurrent write will not alter the final
  outcome after that last pre-mutation check — the same TOCTOU gap documented since v0.2,
  applied specifically to the envelope check.
- **New requirement**: post-commit reconciliation. Every REVALIDATE commit now re-checks
  `committedEffect` against the same envelope immediately after the mutating call returns, and
  surfaces the result via a new `reconciliation: ReconciliationResult` field on
  `SubscriptionChangeReceipt` (`{status:"OK"}` or `{status:"VIOLATED"; reason: string}`). This is
  a **reporting obligation, not a re-authorization gate** — the mutation has already happened by
  the time reconciliation runs, and a `"VIOLATED"` result cannot be undone. It exists so a
  caller is never told a REVALIDATE commit succeeded "within tolerance" when, because of the
  BEST_EFFORT race, that turned out not to be true. Implemented via a new `reconcileCommittedEffect`
  engine function (reusing `checkAcceptanceEnvelope`'s existing violation logic against
  `committedEffect` instead of a fresh re-preview) and wired into all four adapters' commit
  tails. Tested directly in isolation (Test 12a–12c) and end-to-end for the happy path on
  Stripe/Paddle (Test 12k–12l) — see conformance.md gap G-6 for why the actual-violation path
  isn't yet driven end-to-end through a real adapter.

## 3. Normative quote expiration behavior

`validateCommit`'s expiry check (`QUOTE_EXPIRED`, no mutation) has existed since v0.2 — this
cycle elevates it to an explicit top-level normative rule (`scq-v0.6.1-spec.md` §6.10) and
states precisely how it interacts with idempotency (below): expiration applies ONLY to a commit
attempt on a quote that was NEVER successfully committed; a quote that committed successfully
before `validUntil` passed remains validly committed forever after. No code changed — this was
already correct behavior; the gap was that the interaction with idempotency had never been
stated, and a naive idempotency implementation could easily have gotten this wrong (e.g. by
checking expiry before checking for an existing receipt, which would incorrectly re-throw
`QUOTE_EXPIRED` on an idempotent replay of a quote that expired sometime after it successfully
committed). Directly unit-tested (Test 12d, with a fresh contrast case Test 12e) against
`validateCommit` with an injected clock, since every adapter's real `QUOTE_TTL_MS` is 5 REAL
wall-clock minutes, making an end-to-end real-time test impractical.

## 4. Commit idempotency

**This was a genuine, non-trivial gap, not merely an unstated rule.** Before this cycle, a
repeated `commitChangeQuote` call against an already-committed quote threw `CHANGE_CONFLICT`
(a hard error) rather than returning the original receipt — meaning a caller who retried a
commit purely because a response was lost (the mutation succeeded, but confirmation never
arrived) would receive an error instead of the receipt they needed, with no way to distinguish
"this genuinely conflicts with something" from "this already succeeded, here's what happened."

Fixed via:
- A new `commit_receipt?: SubscriptionChangeReceipt` field on the internal `StoredQuote` type
  (store-side only — never part of any wire-visible SCQ type), populated exactly once,
  atomically with the `COMMITTED` status transition, via a new `QuoteStore.recordCommitReceipt`
  method.
- A new `checkIdempotentReplay` engine function, called by every adapter as the FIRST thing
  `commitChangeQuote` does — before any read of live provider state or any mutating call — so
  that idempotent replay can never itself cause a second mutation, and succeeds even if the
  subscription has since drifted further out-of-band or the quote's `validUntil` has since
  passed (see item 3 above for why the latter is correct, not a bug).
- `validateCommit`'s pre-existing `CHANGE_CONFLICT` throw for `status === "COMMITTED"` is now
  reachable only in the structurally-impossible case of a COMMITTED quote with no
  `commit_receipt` — documented as an internal-inconsistency guard, not the normal repeated-commit
  path (which `checkIdempotentReplay` now handles).

Tested end-to-end through real Stripe (Test 12f) and Paddle (Test 12g) adapters: both confirm a
second commit call returns the byte-for-byte original receipt, causes no second mutation, and
(Test 12g specifically) remains correct even when the subscription is mutated out-of-band
between the two commit calls.

## 5. Conformance gaps closed

Three of the four gaps flagged in v0.6's `conformance.md` are closed this cycle:

- **G-1** (no-adapter-lock source scan was Stripe/Paddle-only): Test 7c now scans all four
  adapter source files. No lock construct was found in Zuora's or Chargebee's — the gap being
  closed was in automated verification, not an actual defect.
- **G-3** (`UNSUPPORTED_CHANGE_SET` had no triggering test): a direct unit test (Test 12h) now
  calls `enforceNoPartialExecutionRisk` in isolation with both `mayPartiallyApply: true` (asserts
  the throw, names the at-risk changes) and `false` (asserts no throw). The underlying absence
  of a real END-TO-END adapter path that reaches this rule remains — it is a property of the
  four real reference providers' APIs (none of their adapters constructs a request shape that
  risks silent partial application), not something a v0.6.1-scoped fix can or should close by
  adding a fifth, synthetic provider.
- **G-4** (no Paddle-specific multi-change tests): Test 12i (positive: quantity+plan bundle,
  ATOMIC) and Test 12j (negative: CANCEL+quantity, UNSUPPORTED, refused pre-call) added,
  matching the existing Stripe/Zuora/Chargebee coverage.

Two new gaps were surfaced by this cycle's own additions (recorded honestly rather than glossed
over, per this research's standing discipline): idempotent replay (item 4 above) is exercised
end-to-end only through Stripe/Paddle, not Zuora/Chargebee (G-5); and no test drives an actual
`reconciliation: {status:"VIOLATED"}` result through a real adapter's end-to-end commit call,
only through the isolated engine function (G-6). Neither represents a known failing behavior —
both are absences of a test, and both are documented in `conformance.md`.

## 6. Spec contradiction check

Reviewed the full normative-rule set for tension between "before any provider call" language
(§6.4, §6.7, §6.8, §7.2 in `scq-v0.6-spec.md`) and §5's state-aware quote-level capability
resolution, which requires reading the subscription's actual current state before it can
compute an authoritative, subscription-state-specific `GuaranteeCoverage` override (e.g.
Chargebee's/Zuora's CANCEL-termEffect resolution depending on whether a committed term exists).

**Found**: a real wording ambiguity, not a behavioral bug. "Before any provider call" as
literally written would contradict step 4 of §5's original enumeration (apply the
subscription-state-specific override), which necessarily happens AFTER the one non-mutating
state read every `createChangeQuote` call performs first — that read is itself a "provider
call." No adapter's actual behavior was ever wrong (every reference adapter reads state first,
then computes coverage, then enforces, then calls the provider's preview/mutating operations in
that order) — the SPEC's wording just didn't say precisely enough what "before any provider
call" was scoped to.

**Fix, wording only**: `scq-v0.6.1-spec.md` §5 now opens with an explicit clarification that
every "before any provider call" rule in this document means, precisely, "before any call that
PREVIEWS or MUTATES the proposed change" — never before the initial non-mutating state read that
makes state-aware resolution possible. The step list itself was also renumbered (the state read
is now an explicit step 1; the state-aware override is now step 2, explicitly before the
coverage-combination step that depends on it) purely for clarity — no adapter code changed, and
no test was needed since this was never a runtime behavior gap, only a specification-wording one.

## Schema changes required

Minimal, exactly matching what items 2 and 4 above needed and nothing else:

- `SubscriptionChangeReceipt` gains one new required field: `reconciliation: ReconciliationResult`.
- New type: `ReconciliationResult = { status: "OK" } | { status: "VIOLATED"; reason: string }`.
- `StoredQuote` (internal store type, never wire-visible) gains one new optional field:
  `commit_receipt?: SubscriptionChangeReceipt`.
- Two new engine functions: `checkIdempotentReplay`, `reconcileCommittedEffect`.
- No new `SCQErrorCode`, no new `ChangeAction`, no new provider, no new `EffectiveIntent`
  variant, no change to `GuaranteeCoverage`'s shape, no change to `ChangeSpec`.

## Tests added

12 new test cases across two files:
- `tests/test7-toctou.test.ts`: Test 7c extended in place to scan all four adapters (not a new
  test, but a materially widened one).
- `tests/test12-v061-hardening.test.ts` (NEW FILE, 12 tests): Test 12a–12c (reconciliation logic,
  isolated), Test 12d–12e (quote expiration, direct unit test against `validateCommit`), Test
  12f–12g (commit idempotency, end-to-end Stripe/Paddle), Test 12h (`UNSUPPORTED_CHANGE_SET`,
  direct unit test), Test 12i–12j (Paddle multi-change positive/negative), Test 12k–12l
  (`reconciliation` field present and OK on real REVALIDATE/EXACT receipts).

Full suite: 66 test cases across 11 files, all passing (`npm test`).

## Unresolved blockers

Carried forward from v0.6 (U-1 through U-5, unchanged by this cycle — see
`scq-v0.6.1-spec.md` §9), plus two new ones this cycle's own additions surfaced:

- **U-7 (new)**: post-commit reconciliation cannot prevent a violation, only report it — by
  design, since the mutation has already happened by the time it runs. A caller must treat a
  `reconciliation: {status:"VIOLATED"}` receipt as a materially different, weaker signal than a
  pre-commit `QUOTE_DRIFTED` refusal.
- **U-8 (new)**: idempotent replay keys ONLY on `quoteId`. A caller who creates a second, new
  quote for what is semantically the same intended change (rather than retrying a commit of the
  first quote) gets no deduplication — SCQ has no cross-quote idempotency key, and adding one
  (a caller-supplied idempotency key field) would exceed this cycle's explicit no-new-schema-
  concepts scope.

Also carried forward as conformance-suite (not protocol-level) gaps: G-2 (no test refuses
`EffectiveIntent.TERM_END`, since no reference provider does), and the two new ones from item 5
above (G-5, G-6) — full detail in `conformance.md`.

## Recommendation: **REVIEW_READY**

Every one of the six scoped issues was addressed with the smallest change that genuinely closes
it: two wording-only corrections (EXACT scope, the §5 contradiction), one clarification that
required a real (and, on inspection, genuinely needed) implementation addition (REVALIDATE
reconciliation — the pre-v0.6.1 protocol had no way to surface a post-mutation envelope
violation at all), one rule made explicit with no code change (quote expiration was already
correct), one implementation fix for a real gap that existed prior to this cycle and was not
merely under-specified (commit idempotency previously returned a hard error instead of the
original receipt), and three conformance-suite gaps closed with either an extended existing test
or a new direct unit test, in every case without requiring a fifth provider or any new schema
concept beyond the one field and two types items 2 and 4 required. This is REVIEW_READY, not a
further round of MODIFY, because nothing found this cycle points to an unresolved protocol-level
design question — items 3 and 6 in particular confirm the v0.6 freeze candidate's underlying
behavior was already correct and only needed its documentation to catch up to it. The
unresolved items (U-1 through U-8, G-2/G-5/G-6) are exactly the shape of open questions
appropriate to hand to an external reviewer alongside a hardened spec, not blockers to reaching
one.

---

# Phase 2A Addendum (2026-10-27) — Chargebee Evidence Correction (appended; earlier sections NOT rewritten)

This log is append-only history. The v0.5 and v0.5-LIVE sections above
contain Chargebee capability claims that Phase 2A (see
`research/chargebee-live-v1/CLAIM-CORRECTION-MATRIX.md`) has corrected
in code, tests, and current-facing docs. This addendum supersedes the
following historical statements wherever they conflict — the original
text is preserved above as the record of what was claimed at the time:

1. **v0.5 capability matrix, financial rows** ("EXACT for every
   action", "genuinely stronger than Stripe … and Paddle"): SUPERSEDED.
   No estimate-pinning/replay mechanism is documented for Chargebee's
   estimate→update pair; `effective_from` is not a documented
   `update_for_items` parameter (it is Create-a-ramp's). Both Chargebee
   adapters now report REVALIDATE for both financial dimensions, and an
   overall EXACT request is refused for every Chargebee action. The
   provider-comparison superlatives in that matrix ("genuinely
   stronger", "sharpest asymmetry") are withdrawn as framing — they
   were never evidence statements.
2. **v0.5 matrix, effectiveAt row** ("EXACT — Chargebee's real
   Scheduled Changes mechanism (`effective_from` on
   `update_for_items`)"): SUPERSEDED. DATE is refused by both adapters.
   Documented update-endpoint scheduling is deprecated toward Ramps
   (Early Access, unimplemented here). TERM_END survives only for
   CANCEL, labeled deprecated-but-documented + historically observed.
3. **v0.5 matrix, committed-term CANCEL row** ("EXACT at the quote
   level for BOTH evergreen AND committed-term"): already retracted in
   v0.6 for the committed-term half; Phase 2A additionally narrows the
   evergreen half to the termEffect dimension only (the evergreen quote
   is no longer all-EXACT).
4. **v0.5-LIVE updated matrix, recurring row** ("EXACT, but
   client-computed"): SUPERSEDED. Client-side computation of a
   recurring total from known item prices is normalization work, not a
   provider-backed guarantee; the governing posture is REVALIDATE.
5. **What stands from the historical sections:** the v0.5-LIVE
   observations recorded in research/EVIDENCE.md items 2, 4, 6, 7, 8
   (estimate shape variance, evergreen cancellation semantics for the
   tested subscription, no CAS on the tested path, the tested
   quantity+plan pair, the silent partial-application hazard), item 1
   as a single-configuration observation, item 3 as
   deprecated-but-functional-when-tested, and item 5 as UNVERIFIED.
   No live evidence was added in Phase 1 (live-validation run) or
   Phase 2A — all live cases in both were BLOCKED.

Phase 2A disposition of D-1/D-2 (LIMITATIONS-AND-GAPS.md): corrected at
the adapter/test level; the frozen spec's attributions (§4.1, §3.1,
U-5) are carried as errata proposals
(`research/chargebee-live-v1/ERRATA-PROPOSAL.md`) for a separately
reviewed spec revision. The previously proposed 100→120→100 live
recovery procedure was audited and found NOT COMPLETE; see
`research/chargebee-live-v1/RECOVERY-AUDIT.md`.
