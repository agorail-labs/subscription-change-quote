# Limitations, Gaps, and Specification Discrepancies

Ranked by severity. "Discrepancy" = a place where normative text, simulator behavior,
historical live observation, and current documentation do not all agree. Nothing in
the frozen spec was modified by this experiment; items marked PROPOSAL are for a
separately-approved future cycle.

## D-1 — CRITICAL (claim exceeds documented mechanism): Chargebee EXACT financial coverage

The simulator-backed Chargebee adapter reports `immediateFinancialEffect: EXACT` and
`recurringFinancialEffect: EXACT` for CHANGE_QUANTITY/CHANGE_PLAN/CHANGE_CADENCE/CANCEL,
and the spec (§4.1) attributes this to "Chargebee's `effective_from`" pinning. Current
documentation shows: (a) `effective_from` is not an update_for_items parameter at all —
it is the Create-a-ramp parameter; (b) no estimate-pinning/replay mechanism is
documented for the estimate→update pair; (c) multiple documented drift sources exist
between the two calls (site-setting defaults, balances, conditional tax, prorate
caveat). One historical live case where estimate and commit agreed ($840) does not
constitute a guarantee mechanism.
**Accurate claim today: REVALIDATE for both financial dimensions** — which is what the
new live adapter reports. **Phase 2A status (2026-10-27): CORRECTED in the simulator
adapter and Tests 11a/11b/11g/11h/11j (financials now REVALIDATE, termEffect UNKNOWN,
effectiveAt REVALIDATE — see CLAIM-CORRECTION-MATRIX.md). The §4.1 spec attribution
remains uncorrected in the frozen spec and is carried as an errata proposal
(ERRATA-PROPOSAL.md E-1), requiring a separately reviewed spec revision.**

## D-2 — HIGH (deprecated/early-access mechanisms): TERM_END and DATE on Chargebee

Spec §3.1 rationale and the simulator adapter present `end_of_term=true` and
`effective_from` as Chargebee's two live scheduling mechanisms. Current docs:
`end_of_term` (boolean and via `change_option`) is deprecated in favor of Ramps;
`change_option=specific_date`/`changes_scheduled_at` is deprecated for future
scheduling (still allowed for backdating); Ramps is **Early Access** and site-gated.
The mechanisms were historically observed working (v0.5-LIVE), so "deprecated but
functional when last tested" is the accurate status — but SCQ's supported-intent
advertising does not distinguish current / deprecated / early-access, and no Ramps
implementation exists in the repo. The live adapter refuses TERM_END/DATE (T14).
**Phase 2A status (2026-10-27): the simulator adapter now also refuses DATE (all
actions) and TERM_END (update-backed actions), and no longer advertises them —
Test 11d rewritten as a refusal test. TERM_END for CANCEL is retained as
deprecated-but-documented + historically observed, explicitly labeled as such
in the adapter. Advertising a current/deprecated/early-access distinction in
the SCQ capability model itself remains a spec-level question (ERRATA-PROPOSAL.md
E-2/E-3) — not resolved by adapter changes.**

## D-3 — HIGH (durability): exactly-once rests on an in-memory store + a 30-minute native window

Spec §6.10's idempotent-replay rule is implemented via `QuoteStore`, an in-memory
`Map`. Across a process restart the receipt is unrecoverable: the live adapter fails
closed (T13), which prevents double mutation but also means a legitimate retry after
restart cannot be answered — availability and exactly-once both depend on state the
reference implementation does not persist. Chargebee's native window (30 minutes)
does not close this gap. **Required for a conforming live deployment:** a durable,
transactional quote/receipt store (atomic status+receipt write keyed by quote id,
surviving restart), retention of the native idempotency key + exact request
parameters for the commit, and a documented policy for retries beyond 30 minutes
(reconcile-by-read first; never blind re-mutation). A mocked persistent store would
not count as evidence of this.

## D-4 — MEDIUM (TOCTOU remains, correctly labeled): no CAS, millisecond version granularity

No documented precondition exists on update_for_items; historical live testing found
`If-Match` ignored. SCQ's BEST_EFFORT reporting is honest and the post-commit
reconciliation (§6.11) detects the outcome (T08/T09) — but detection is not
prevention, and callers must build an operational response to VIOLATED receipts.
Additionally, `resource_version`'s millisecond granularity can miss two changes in
the same millisecond, a detection gap the simulator's content-hash fingerprint does
not have; the live adapter inherits it from the real API.

## D-5 — MEDIUM (simulator/API shape drift): `replace_items_list`, endpoint and parameter assumptions

The simulator applies "the provided item list replaces the subscription's items" as
an unconditional semantic. The real API defaults `replace_items_list=false`
(additive), retains mandatory addons, and behaves differently for plan-vs-addon-only
lists and multi-plan sites. An adapter patterned directly on the simulator would
silently accumulate addons live. The live adapter sends the full list with
`replace_items_list=true` explicitly (T03). Simulator comments also reference an
`?estimate=true`-style preview on the update endpoint; the documented preview is the
separate estimates family. **Phase 2A status: simulator/adapter comments corrected
(the `?estimate=true` description and the unconditional-replacement framing are
removed/scoped; the live adapter's updateParams now documents the mandatory-addon
caveat explicitly). The simulator's data model still does not represent
replace_items_list or mandatory addons — a modeling gap, now labeled rather than
silent (CLAIM-CORRECTION-MATRIX.md C-11/C-16).**

## D-6 — MEDIUM (site variance is unmodeled): capability reporting is not site-scoped

`prorate`/`invoice_immediately` defaults, backdating, Contract Terms, multi-plan,
calendar billing, Ramps, and Net D are all site-configuration dependent. Two sites
can return different results for identical SCQ calls while the adapter reports
identical capabilities. SCQ v0.6.1 has no site-capability dimension; the live adapter
mitigates only by pinning the two financial defaults explicitly.

## D-7 — LOW (documentation inconsistency inside Chargebee's own docs)

The estimate page describes `end_of_term` as "Deprecated — use `change_option`
instead", while the update page describes it as "Deprecated — use the Create a ramp
API instead", and `change_option=end_of_term` is itself deprecated toward Ramps.
Integrators following only one page will pick a deprecated path. Recorded here so
future SCQ work cites the update page's (stronger) deprecation.

## Standing limitations (not discrepancies — known, honestly reported)

- **Reconciliation ≠ prevention/rollback** (spec U-7): a VIOLATED receipt means the
  money already moved; SCQ offers no compensating action.
- **Cross-quote deduplication does not exist** (spec U-8): two distinct quotes for the
  same intent can both commit. Native idempotency does not help — different quotes
  derive different keys.
- **Envelope ≠ authorization**: quote-relative drift tolerance only; no absolute
  spending cap, no identity/consent semantics (security considerations §5/§14).
- **Unmodeled money**: taxes (conditional), coupons/discounts, balances, FX, the
  prorate=false→true credit caveat for sequential in-term changes.
- **Committed-term CANCEL on Chargebee remains UNVERIFIED** (spec U-1): no Contract-
  Terms-enabled site was available in the prior cycle and none in this one.
- **Second-provider portability is unproven live**: Stripe/Paddle/Zuora remain
  documentation-backed simulations (NATIVE-VS-SCQ §D).
- **This run added zero live evidence**: all live rows are BLOCKED by design
  (no credentials). Any future claim upgrade requires the approved live experiment in
  TEST-RESULTS.md.
