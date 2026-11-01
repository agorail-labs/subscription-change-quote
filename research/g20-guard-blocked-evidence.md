# G-20 — Guard-blocked research harnesses: per-case evidence accounting

**Gap:** G-20 (register: `research/v0.6.2-release-gaps.md`). **Program:** Issue #29
conformance/regression closure. **Base:** `origin/main` @ `9bb424b` (suite 721/721,
research suite 11 pass / 7 fail, Node 22). **Companion change:** `test55`
(`reference/tests/test55-g20-guard-blocked-evidence.test.ts`), two simulator-level
pins. **No repro harness was modified; no guard was weakened; the research suite
still stands at 11 pass / 7 fail after this change — that is the honest outcome,
not a defect to be repaired by editing the harnesses.**

## Why all seven cases fail today (one mechanism)

Every blocked harness performs a commit through the **Chargebee live adapter**
with a proposal that carries **no explicit `authorizationScope`** — so the
effective scope is **OPERATION** (the default). The live adapter's only update
dispatch is a full-list replacement (`update_for_items`,
`replace_items_list=true`) on a **FULL_REPLACEMENT_ONLY** capability. Since
PR #24 (PR-14), `commitChangeQuote` therefore refuses **pre-dispatch** with
`AUTHORIZATION_PRESERVATION_UNENFORCEABLE` — after the identity, expiry,
fingerprint and revalidation stages, before any durable dispatch attempt is
created and before any mutating request. All seven observed failures are that
one thrown `SCQError`, verbatim:

> "Commit refused before dispatch: this quote is OPERATION-authorized, but the
> adapter's update dispatch is a full-list replacement (replace_items_list=true)
> on a FULL_REPLACEMENT_ONLY capability, which cannot atomically preserve
> unrelated subscription state that changes after validation. … No mutating
> request was dispatched and no durable dispatch attempt was created."

No conforming configuration re-opens the path: OPERATION refuses pre-dispatch,
and TARGET_REPLACEMENT is refused at quote creation on this adapter
(test47.7). The live adapter consequently dispatches **no** update mutation in
any main-suite test either — its post-dispatch code is reached only through
seeded-receipt fixtures (e.g. test26) and store-level verification. Each case
below is therefore accounted as: the intended property, the converted pins that
already carry it at reachable layers, any new pin added here, and what remains
unreachable **by design** (with the reason — never by manufacturing a fixture
that misrepresents the adapter's capability).

## Per-case matrix

### repro43.1 — F1: concurrent unauthorized addition deleted by full-list replacement (defect case)

- **Intended property (disjunctive, as the repro asserts it):** an execution
  whose dispatched full-list replacement deletes an item outside the authorized
  change set must NOT be reported `COMMITTED_AND_VERIFIED` / OK — the receipt
  must surface the loss (MISMATCH / UNVERIFIED / VIOLATED) **or the commit must
  have refused**. Target-state equality against the stale intended set is not
  authorization preservation.
- **Why blocked:** the commit refuses at the preservation gate (above); no
  dispatch occurs, so the race the repro stages (addition landing after the
  final pre-commit read) can never happen on this adapter.
- **Already pinned:** the refusal branch, on the live adapter itself —
  **test47.1** (the repro43.1 scenario converted: concurrent addition in the
  validate→dispatch window → refusal, zero dispatches, item survives, no
  DISPATCHING attempt), **test47.2** (the refusal is scope-based, not
  concurrency-observed), **test47.3** (addition before the commit-phase read →
  QUOTE_STALE, zero dispatches; the research file's own passing control).
- **Newly pinned here (simulator level):** on an adapter that DOES dispatch
  (Chargebee simulator adapter) — **test55.1** (quote→commit window: unrelated
  addition refuses QUOTE_STALE; the adapter's fingerprint is a content hash over
  the FULL subscription state; zero dispatches; the addition survives) and
  **test55.2** (validate→dispatch window: the dispatch lands and — mechanics
  disclosed — deletes the addition, because the dispatched request is the
  validated state's item list; but the receipt caps at
  `COMMITTED_UNVERIFIED` / UNVERIFIED via the attribution bracket — the
  artifact's begin fingerprint ≠ the validated fingerprint — with NO committed
  recurring figure). Labels: DIRECT PROOF of the simulator adapter's bracket
  and receipt classification; ILLUSTRATIVE for the live race.
- **Remains unreachable:** the literal live dispatch. By design (above). If a
  future documented conditional write or targeted update ever gives this
  adapter a preservation-enforceable dispatch, repro43.1 becomes reachable and
  this accounting must be redone (the register's standing instruction).
- **Nuance surfaced by test55.2 (flagged, not fixed):** the recorded immediate
  figure in the broken-bracket receipt (12500) is the bound artifact's own
  actual, priced by the simulator from the state the operation BEGAN on —
  which already included the concurrent addition (begin recurring 107500 →
  end 120000) — not from the state the commit validated, where the authorized
  change's delta alone is 20000. The classification is safe (UNVERIFIED,
  recurring unattributed), but a maintainer should decide whether an
  artifact-priced immediate under a broken bracket should be recorded as
  DETERMINED at all. No behavior was changed by this PR.
- **Resolution (Issue #46 audit, decision B — NARROW):** the flagged question
  was audited in `research/i46-immediate-attribution-audit.md` (suite test60).
  The maintainer question is answered: NO — where the artifact's BEGIN
  binding fails (the operation did not begin on the state the commit
  validated, or the artifact's recorded request is not the dispatched
  request), the figure nets third-party effects and is now recorded as a
  §3.10 candidate (UNKNOWN determinacy, `committedSource: "unestablished"`,
  source disclosed), per spec §6.15. Where only the bracket's END equality
  fails (interference after execution; the begin binding holds), the figure
  remains DETERMINED — it is priced from the validated state and the
  dispatched request alone. test55.2's classification assertion was updated
  accordingly (disclosed in that suite's header); its scenario mechanics and
  the figure's value are unchanged.

### repro43.2 — F1 control: no concurrent write

- **Intended property:** the identical live quote+commit with NO concurrent
  write verifies `COMMITTED_AND_VERIFIED` / OK — the control that bounds the
  defect (the clean path works when nothing interferes).
- **Why blocked:** the same scope-based refusal. The gate does not observe
  concurrency; the control hits it exactly as the attack does.
- **Already pinned (as a deliberate doctrine conversion):** **test47.2** — the
  no-concurrency OPERATION commit through this adapter STILL refuses; absence
  of observed concurrency is not safety, so the control's expected outcome was
  reversed by PR #24, on purpose. The underlying clean-verify property is
  pinned wherever dispatch is permitted: simulator adapters end-to-end
  (test25.1 Chargebee-sim `COMMITTED_AND_VERIFIED` / OK; test17/19/24
  analogues), store-level verification composition (test50; test26's
  seeded-receipt verification), and **test47.11** (read-only flows and the
  simulator adapter's commits unaffected by the gate).
- **Newly pinned:** none needed.
- **Remains unreachable:** a successful update dispatch through the Chargebee
  live adapter — by design, for the standing reason. This is a policy outcome,
  not a coverage defect to manufacture around.

### repro45.1 — F3: post-commit re-read names a different subscription

- **Intended property:** a post-commit re-read naming a different
  `subscription.id` must not verify VERIFIED/OK — post-dispatch evidence is
  identity-bound to the quoted subscription. (Finding 3's original defect: the
  adapter consumed the re-read's items/fingerprint without ever checking the
  id; the fingerprint is resource-version-based, so identity was not even an
  input to the bracket.)
- **Why blocked:** the commit never dispatches, so no post-commit re-read ever
  occurs in the harness.
- **Already pinned, at every reachable layer:** **test49.1** (same adapter,
  pre-dispatch half: a commit-phase validation read naming a different
  subscription refuses pre-dispatch — CONFIRMED_NON_EXECUTION, zero dispatches,
  zero durable attempts), **test49.2** (creation-read identity refusal),
  **test49.3** (post-dispatch evidence binding: evidence whose resulting
  snapshot names a different subscription cannot verify the record),
  **test49.5** (simulator end-to-end: a Stripe post-commit read returning a
  foreign record does not verify OK), **test50.7** (a foreign observed snapshot
  is refused at evidence ingestion).
- **Code state (implemented, end-to-end unreachable):** PR #26 also closed the
  literal layer — `establishLiveCommit` treats a post-commit re-read naming a
  different subscription as unavailable evidence (the identity failure is named
  in the classification reasons; the foreign record's state and financials are
  never consumed). No test can reach that code while every update dispatch is
  refused pre-dispatch; it is recorded here so the accounting distinguishes
  "unimplemented" (false) from "implemented but unreachable" (true).
- **Newly pinned:** none — the property is pinned at every layer a test can
  reach.

### repro45.2 — F3 control: re-read names the SAME subscription

- **Intended property:** the identical flow with the re-read naming the quoted
  subscription verifies cleanly (`COMMITTED_AND_VERIFIED` / OK, resulting
  snapshot id = the quoted subscription).
- **Why blocked:** the same OPERATION refusal; the control never dispatches.
- **Already pinned:** **test49.4** (the same verification with the bound
  subscription's snapshot transitions exactly as before), **test49.6** (a
  recorded receipt replays exactly, before any identity or unit check runs),
  **test49.13** (engine-level clean-reconcile control), and the simulator
  clean-commit suites (test25.1 and analogues).
- **Newly pinned:** none needed.
- **Remains unreachable:** the literal live-adapter clean dispatch — the
  standing design reason (see repro43.2).

### repro46.1 — F5a: evidence establishing a candidate-less dimension

- **Intended property:** later evidence establishing a dimension the recorded
  receipt left candidate-LESS (here: no immediate candidate) must be
  recordable as appended evidence and reflected in the derived view — not
  refused as `CONFLICTING_RECEIPT_IDENTITY`. (Pre-PR #27, candidate-equality
  WAS the store's identity check, so a missing candidate could never be
  filled.)
- **Why blocked:** the harness generates its `COMMITTED_UNVERIFIED` receipt
  through a live commit; the preservation refusal means no receipt exists, so
  the store layer the property governs is never reached.
- **Already pinned, exactly:** **test50.1** — a receipt missing an immediate
  candidate incorporates independently established immediate actuals. test50
  constructs the same receipt state at the store layer from
  provider-record-derived fixtures, which is the layer the property actually
  governs; the live commit in the repro was only a fixture-generation route.
- **Newly pinned:** none needed. **Remains unreachable:** nothing about the
  property — only the harness's fixture route.

### repro46.2 — F5b: evidence establishing a DIFFERENT actual than the candidate

- **Intended property:** evidence establishing a different actual than the
  recorded candidate (candidate recurring 80900; provider record establishes
  83400) must be recordable as verified-with-violation (reconciliation
  VIOLATED), never refused as an identity conflict and never silently OK —
  while the recorded ORIGINAL receipt stays immutable (the repro's replay
  control).
- **Why blocked:** same fixture-route block as repro46.1.
- **Already pinned, exactly:** **test50.2** (different-actual evidence is
  recordable — verified-with-violation, never an identity conflict),
  **test50.17** (verified-with-violation is distinguishable from
  verified-with-compliance), **test50.4** (§6.10 replay remains byte-equivalent
  after verification — the immutability control).
- **Newly pinned:** none needed. **Remains unreachable:** nothing about the
  property.

### repro46.3 — F5c: verified view must not present candidate provenance

- **Intended property:** after confirming verification, the derived current
  view must not present `COMMITTED_AND_VERIFIED` / OK over figures still
  labeled determinacy UNKNOWN with `committedSource: "unestablished"` — the
  view's displayed provenance must be the establishing evidence's.
- **Why blocked:** same fixture-route block as repro46.1.
- **Already pinned, exactly:** **test50.3** — confirming evidence produces a
  verified view whose displayed provenance is the establishing evidence's
  (DETERMINED, not UNKNOWN/unestablished); **test50.4** keeps the recorded
  original's labels untouched, as the repro's control requires.
- **Newly pinned:** none needed. **Remains unreachable:** nothing about the
  property.

## Summary accounting

| Case | Finding | Property pinned at | New pin | Research outcome (unchanged) |
|---|---|---|---|---|
| repro43.1 | F1 | test47.1/47.2/47.3 (live, refusal branch) + test55.1/55.2 (simulator, both windows) | test55.1, test55.2 | still failing at the gate — by design |
| repro43.2 | F1 control | test47.2 (doctrine conversion: refusal) + clean-verify pins in test25/test50/test26 | — | still failing at the gate — by design |
| repro45.1 | F3 | test49.1/49.2/49.3/49.5, test50.7; literal layer implemented in `establishLiveCommit`, unreachable | — | still failing at the gate — by design |
| repro45.2 | F3 control | test49.4/49.6/49.13 + simulator clean commits | — | still failing at the gate — by design |
| repro46.1 | F5a | test50.1 | — | still failing at the gate — fixture route only |
| repro46.2 | F5b | test50.2/50.17/50.4 | — | still failing at the gate — fixture route only |
| repro46.3 | F5c | test50.3/50.4 | — | still failing at the gate — fixture route only |

**Counts:** main suite 721/721 (base `9bb424b`) → **723/723** with test55
(Node 22; Node 20 via CI). Research suite **11 pass / 7 fail**, unchanged —
every one of the seven is the preservation refusal above. `test55.1/55.2`
passed on first run against unmodified code: they are regression pins for
existing behavior, disclosed as such, not failing-first defect reproductions.
No implementation file, no repro harness, and no guarded path was modified by
this change; no pre-existing test was modified.
