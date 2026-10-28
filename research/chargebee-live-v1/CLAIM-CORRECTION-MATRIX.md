# Claim-Correction Matrix — Chargebee (Phase 2A, Task 1)

Every Chargebee-specific claim about EXACT coverage, TERM_END / DATE
scheduling, atomicity, or idempotency found in the audit scope, with its
disposition. Audit scope: `reference/src/adapters/chargebee-adapter.ts`,
`reference/src/adapters/chargebee-sim.ts`, `reference/src/live/*`,
`reference/src/store/quote-store.ts`, all tests (esp. test11/test12/test13),
README(s), `spec/`, `research/EVIDENCE.md`, `research/research-findings.md`,
`research/chargebee-live-v1/*`, `conformance/`, `examples/`, `docs/`,
`standards/`, `reference/demo/`.

**Conventions.** Locations cite the file and line/section **at commit
5dbb9c7** (pre-correction HEAD), so the original wording can be diffed.
Verdicts: `supported` / `not established` / `contradicted-by-docs` /
`deprecated-but-documented` / `simulator-only`. "Correction applied" =
changed in this Phase 2A commit. "Errata-proposed" = the claim lives in
the frozen normative spec; the spec text is NOT touched — see
ERRATA-PROPOSAL.md. Language discipline applied throughout: undocumented
`effective_from` financial pinning is **NOT ESTABLISHED**; no row claims
proof that no equivalent mechanism exists anywhere.

Evidence shorthand: DOCS = current official docs at
apidocs.chargebee.com, re-read 2026-10-27 (Phase 1 audit + Phase 2A
recovery audit); HIST = limited historical live research, prior
v0.5-LIVE cycle, recorded in research/EVIDENCE.md; SIM = simulator
behavior only.

---

## A. Simulator-backed adapter (`reference/src/adapters/chargebee-adapter.ts`)

### C-01 — Financial EXACT for every action
- **Location:** chargebee-adapter.ts:80-81 (at 5dbb9c7), `capabilitiesFor`
- **Original wording:** `immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT"` for CHANGE_QUANTITY, CHANGE_PLAN, CHANGE_CADENCE, and CANCEL.
- **Evidence/source:** DOCS — no estimate-pinning/replay mechanism documented for the estimate→update pair; multiple documented drift sources (site-setting defaults for `prorate`/`invoice_immediately`, balances via `use_existing_balances`, conditional tax, prorate caveat). HIST — one agreeing case ($840, EVIDENCE item 1) is a single observation, not a mechanism.
- **Verdict:** not established (the EXACT guarantee claim); the underlying estimate→update comparability is DOCUMENTATION_SUPPORTED only in the conditional sense of audit A4.
- **Correction applied:** both dimensions now `"REVALIDATE"` for every action, matching the live adapter. Tests 11a/11b/11g/11h rewritten (EXACT requests now refuse on `immediateFinancialEffect`).

### C-02 — `effective_from` pinning as the EXACT mechanism
- **Location:** chargebee-adapter.ts:52-55 (doc comment), :466-471 (commit comment, at 5dbb9c7); spec §4.1 (see C-19).
- **Original wording:** "EXACT everywhere — real, confirmed by the v0.5-LIVE session: estimate matched committed invoice exactly"; commit path: "Chargebee's proration pivots on an explicit effective_from input … so replay reproduces the quoted number exactly".
- **Evidence/source:** DOCS — `effective_from` does not appear in the documented `update_for_items` parameter list (read in full); it is the required parameter of Create-a-ramp.
- **Verdict:** not established (as an update-endpoint pinning mechanism). Explicitly NOT "contradicted everywhere": no claim is made that no equivalent mechanism exists in any Chargebee product surface — only that none is documented for this endpoint pair.
- **Correction applied:** both comments rewritten; commit path now carries the CANCEL-only justification with the pinning rationale removed. Spec attribution → errata-proposed (E-1).

### C-03 — termEffect EXACT for CHANGE_QUANTITY
- **Location:** chargebee-adapter.ts:80 (at 5dbb9c7).
- **Original wording:** `termEffect: "EXACT"` for CHANGE_QUANTITY.
- **Evidence/source:** DOCS — `force_term_reset`, automatic term reset on billing-period change, and contract-term parameters mean term consequences are not fully derivable from the estimate/update pair (audit A8).
- **Verdict:** not established.
- **Correction applied:** `termEffect: "UNKNOWN"` for every action at the coarse level (the sole quote-level exception is C-06).

### C-04 — effectiveAt EXACT for every action
- **Location:** chargebee-adapter.ts:80-81 (at 5dbb9c7).
- **Original wording:** `effectiveAt: "EXACT"` for all actions.
- **Evidence/source:** DOCS — IMMEDIATE semantics are documented, but no pinning backs an exactness guarantee; for scheduled intents the mechanisms are deprecated/early-access (C-05).
- **Verdict:** not established as EXACT.
- **Correction applied:** `effectiveAt: "REVALIDATE"` for every action, matching the live adapter.

### C-05 — supportedEffectiveIntents [IMMEDIATE, TERM_END, DATE] for every action
- **Location:** chargebee-adapter.ts:82 and doc comment :56-75 (at 5dbb9c7).
- **Original wording:** all three intents advertised for all four actions; DATE "via `effective_from` … advertised as supported (the mechanism's existence and response shape were confirmed live…)".
- **Evidence/source:** DOCS — on `update_for_items`: `end_of_term` boolean and `change_option=end_of_term` are deprecated toward Ramps; `change_option=specific_date` + `changes_scheduled_at` (future) is deprecated for scheduling (still documented for backdating); Ramps is Early Access and site-gated. `effective_from` is not an update parameter (C-02). HIST — `end_of_term` behaviors were observed working in the prior cycle.
- **Verdict:** DATE-on-update: not established. TERM_END-on-update and TERM_END-on-cancel: deprecated-but-documented (+ historically observed). IMMEDIATE: supported.
- **Correction applied:** update-backed actions (CHANGE_QUANTITY / CHANGE_PLAN / CHANGE_CADENCE) now advertise `["IMMEDIATE"]` only — DATE and TERM_END refused before any preview/mutation (Test 11d rewritten as a refusal test). CANCEL advertises `["IMMEDIATE", "TERM_END"]`, explicitly labeled deprecated-but-documented + historically observed in the adapter comment. Rationale for refusing despite deprecated-but-documented status: the simulator never modeled `end_of_term` on update as the distinct boolean the endpoint takes (it folded TERM_END into the undocumented timestamp field — C-08), and no Ramps implementation exists to offer the current mechanism.

### C-06 — Evergreen CANCEL: all-EXACT quote
- **Location:** chargebee-adapter.ts:110-111 `quoteLevelCancelTermCoverage` + Test 11g deep-equal (at 5dbb9c7).
- **Original wording:** evergreen CANCEL quote coverage `{EXACT, EXACT, EXACT, EXACT}`, creatable with `guaranteeMode: "EXACT"`, described as "confirmed live … estimate and commit agreed exactly, no fee".
- **Evidence/source:** HIST — EVIDENCE item 4 supports evergreen cancellation semantics for the tested subscription, including the term outcome (no commitment, no fee observed). DOCS — nothing pins the financial dimensions (C-01).
- **Verdict:** termEffect EXACT for evergreen CANCEL: supported (limited historical observation, dimension-scoped). Financial/effectiveAt EXACT: not established.
- **Correction applied:** quote-level override retained for termEffect ONLY; the quote now reads `{REVALIDATE, REVALIDATE, EXACT, REVALIDATE}` and an overall EXACT request for evergreen CANCEL is refused on `immediateFinancialEffect` (Test 11g/11h rewritten).

### C-07 — Committed-term CANCEL termEffect UNKNOWN (v0.6 correction)
- **Location:** chargebee-adapter.ts:110-111; spec §6.9.
- **Original wording:** committed-term CANCEL resolves UNKNOWN (UNVERIFIED — Contract Terms not enabled on the historical test site).
- **Evidence/source:** HIST (absence of evidence, honestly recorded); DOCS (Contract Terms is a site-enabled feature).
- **Verdict:** supported (as the honest posture). Unchanged by Phase 2A, except that the EXACT-refusal failing dimension for this case is now `immediateFinancialEffect` (financials fail first) — Tests 11g updated; the termEffect UNKNOWN assertion itself is preserved on the REVALIDATE quote.

### C-08 — TERM_END-for-update modeled by folding into a timestamp
- **Location:** chargebee-adapter.ts:316-340 (at 5dbb9c7).
- **Original wording:** "this sim models TERM_END by resolving it to the subscription's own known currentTermEnd and passing THAT as effectiveFrom to the update sim call — real Chargebee's own `update_for_items` accepts `end_of_term` as a genuinely separate boolean parameter (confirmed live…)".
- **Evidence/source:** DOCS — `end_of_term` is a real documented boolean on update_for_items, but deprecated (C-05); the folding mechanism depends on the undocumented timestamp field (C-02).
- **Verdict:** simulator-only (the folding); deprecated-but-documented (the underlying boolean, which the sim does not model).
- **Correction applied:** the folding path is removed from the adapter — after `enforceEffectiveIntent`, update previews always carry `effectiveFrom: undefined`; the comment block now explains why DATE / update-TERM_END can never reach the preview code.

### C-09 — Multi-change ATOMIC (quantity+plan)
- **Location:** chargebee-adapter.ts:115-124 `multiChangePairSupport`; Test 11e.
- **Original wording:** "`update_for_items` accepts a full item list in one call (quantity AND plan/cadence swaps bundle atomically…)"; Test 11e title "is ATOMIC on Chargebee".
- **Evidence/source:** DOCS — a single update call carrying a full item list is the documented shape. DOCS caveats: `replace_items_list` defaults false (additive); plan-inclusive vs addons-only lists behave differently; mandatory addons survive unless `mandatory_items_to_remove` (recovery audit R-3). No CAS exists, so ATOMIC cannot mean precondition+mutation atomicity.
- **Verdict:** supported with narrowed scope — single-request bundling in the simulator model; NOT a transactional/CAS claim. ConsistencyGuarantee remains BEST_EFFORT everywhere (supported, audit A5).
- **Correction applied:** comment and Test 11e title/log scoped to "MultiChangeConsistency ATOMIC = single modeled call"; Test 11e now also asserts `consistencyGuarantee: "BEST_EFFORT"` on the same receipt. The real-API replacement caveats are documented in the adapter comment and RECOVERY-AUDIT.md; the simulator still does not model `replace_items_list`/mandatory addons (labeled modeling gap, C-11).

### C-10 — CANCEL+anything UNSUPPORTED; no silent partial execution
- **Location:** chargebee-adapter.ts `multiChangePairSupport` / `enforceNoPartialExecutionRisk` call site; Tests 11f, 12h (engine-level).
- **Original wording:** CANCEL bundling refused because `cancel_for_items` is a separate endpoint; adapter never risks silent subset application.
- **Evidence/source:** HIST — EVIDENCE item 8 (silent partial application observed live for malformed cancellation+mutation combinations); DOCS — separate endpoints.
- **Verdict:** supported. No correction; Phase 2A re-verified the call sites pass `mayPartiallyApply: false` only for constructions that cannot drop a change.

## B. Simulator (`reference/src/adapters/chargebee-sim.ts`)

### C-11 — "The provided item list replaces the subscription's items" (unconditional)
- **Location:** chargebee-sim.ts `applyItems` / `updateForItems` semantics; header (at 5dbb9c7).
- **Original wording:** sim applies the input list as the subscription's items, unconditionally.
- **Evidence/source:** DOCS — real default is `replace_items_list=false` (additive); replacement is conditional on the flag, list composition, multi-plan setting, and mandatory addons (audit A9, recovery audit R-3).
- **Verdict:** simulator-only (as a model of the sim's own arithmetic); contradicted-by-docs as a description of the real API default.
- **Correction applied:** adapter comment (C-09) and live-adapter `updateParams` comment now state the documented conditional semantics and the mandatory-addon caveat explicitly; the sim's internal semantics are unchanged (it models the post-replacement state) but no text now presents them as the real API's default behavior. The sim still has no `replace_items_list` field — recorded as a labeled modeling gap in LIMITATIONS D-5 (Phase 2A status).

### C-12 — `effective_from` as "a real, documented Chargebee parameter" of update_for_items; Scheduled Changes via update timestamp
- **Location:** chargebee-sim.ts header :27-35 and `UpdateForItemsInput.effectiveFrom` doc :114 (at 5dbb9c7).
- **Original wording:** "plus optionally schedule the change via `effective_from` — a real, documented Chargebee parameter: `Termed` … or `TermEnd` … Chargebee DOES support scheduling … (`POST /subscriptions/{id}/update_for_items` with `effective_from` as a unix timestamp)".
- **Evidence/source:** DOCS — see C-02/C-05. (`Termed`/`TermEnd` vocabulary in the original also matches no documented `change_option` values, which are `immediately` / `end_of_term` / `specific_date`.)
- **Verdict:** not established (update-parameter claim); deprecated-but-documented (the actual update-endpoint scheduling paths); Early Access (Ramps, the actual home of `effective_from`).
- **Correction applied:** header paragraph rewritten; the sim field is relabeled "SIMULATOR-ONLY scheduling field — NOT a documented `update_for_items` parameter", retained only so the sim's legacy pending-change arithmetic stays exercisable at the sim layer; the adapter never sends a future value (C-08).

### C-13 — `?estimate=true`-style preview on the update endpoint
- **Location:** chargebee-sim.ts header :37 (at 5dbb9c7).
- **Original wording:** "`POST /subscriptions/{id}/update_for_items?estimate=true`-style preview: Chargebee has a genuine, documented non-mutating ESTIMATE endpoint family…".
- **Evidence/source:** DOCS — the documented preview is the separate estimates family (`POST /estimates/update_subscription_for_items`); no `estimate=true` parameter is documented on update_for_items (audit A10).
- **Verdict:** contradicted-by-docs (the `?estimate=true` framing); supported (the estimates family itself).
- **Correction applied:** header rewritten to cite the estimates family only, with the correction flagged inline.

### C-14 — Committed-term cancellation termEffect EXACT via contract_term data ("documented asymmetry vs Zuora")
- **Location:** chargebee-sim.ts header :58-65 and `previewCancel` comment (at 5dbb9c7).
- **Original wording:** "Chargebee's committed-term cancellation termEffect is EXACT if `contract_term` is present and the cancel estimate call is used, whereas Zuora's is UNKNOWN"; "This is the documented asymmetry vs. Zuora".
- **Evidence/source:** none — simulator-only formula; the case is UNVERIFIED against any Contract-Terms-enabled site (EVIDENCE item 5). (The adapter-level claim had already been retracted in v0.6; the sim header/comment lagged that correction.)
- **Verdict:** simulator-only; retracted.
- **Correction applied:** both texts rewritten — the sim's pro-rata fee is labeled a simulator invention, no capability claim may be derived from it, and the adapter's UNKNOWN posture is restated.

### C-15 — Sim proration determinism ⇒ financial EXACT
- **Location:** chargebee-sim.ts `computeUpdateEffect` comment :293-301 (at 5dbb9c7).
- **Original wording:** "This is why Chargebee's financial dimensions can be EXACT: the pivot is always an explicit input…".
- **Evidence/source:** SIM determinism proves nothing about the real pair (C-01); the sim in fact computes proration from its own ambient clock at call time, so elapsed sim time changes the number — now demonstrated by Test 11a's drift half (QUOTE_DRIFTED under a zero-tolerance envelope).
- **Verdict:** simulator-only reasoning; conclusion not established.
- **Correction applied:** comment rewritten to state exactly that, and to explain why the adapter revalidates.

### C-16 — Sim version/fingerprint framing
- **Location:** chargebee-sim.ts header versioning bullet; Test 11i title (at 5dbb9c7).
- **Original wording:** "Chargebee subscriptions do NOT expose a documented monotonic version integer… The closest thing is `updated_at`/`resource_version` millisecond timestamps"; Test 11i "Chargebee has NO native version field".
- **Evidence/source:** DOCS — `resource_version` is documented (millisecond timestamp, updated on every change; documented use includes webhook ordering) and the live adapter uses it (`rv:<n>`) for stale detection; no documented CAS precondition exists (audit A5).
- **Verdict:** supported as narrowed — no CAS/monotonic-integer claim is correct; the blanket "no native version field" phrasing was imprecise for the real API (accurate only for the simulator, which models no such field).
- **Correction applied:** Test 11i retitled/scoped to the simulator; sim header already carried the uncertainty flag and is retained with the audit cross-reference in the adapter comment.

## C. Tests

### C-17 — Test 11a/11b/11c/11d/11j EXACT-mode Chargebee commits
- **Location:** reference/tests/test11-chargebee.test.ts (at 5dbb9c7): 11a (EXACT quantity, elapsed-time proof), 11c (EXACT TERM_END cancel), 11d (DATE honored, effectiveAt EXACT), 11j (EXACT TOCTOU setup); 11b (EXACT refusal naming termEffect).
- **Original wording:** as titled at 5dbb9c7.
- **Evidence/source:** C-01/C-04/C-05.
- **Verdict:** not established (11a/11c/11d claims); supported behavior with wrong failing dimension (11b/11j setups).
- **Correction applied:** 11a rewritten (REVALIDATE end-to-end + EXACT refusal + elapsed-time QUOTE_DRIFTED demonstration); 11b failing dimension → `immediateFinancialEffect`; 11c → REVALIDATE TERM_END cancel; 11d rewritten as DATE/update-TERM_END refusal + capability/enforcement agreement + no-mutation; 11j → REVALIDATE setup (TOCTOU assertions unchanged). Test 12's Chargebee references are engine-level only (12h) or name Chargebee in comments — no Chargebee capability assertion; no change needed. Test 13 (live adapter) already encoded the corrected posture (REVALIDATE/UNKNOWN, IMMEDIATE-only, T14 refusal) — no assertion change; it is the reference the simulator was aligned to.

### C-18 — Test counts in docs ("66 tests")
- **Location:** README.md:94,147; conformance/conformance.md:3; docs/EXPERIMENTAL-PREVIEW.md; .github/pull_request_template.md; standards/ACP-PRE-SEP.md:408 (at 5dbb9c7).
- **Original wording:** suite described as 66 tests (stale after Phase 1 added test13's 18).
- **Verdict:** contradicted by the suite itself (84 at 5dbb9c7 and after Phase 2A).
- **Correction applied:** all updated to 84 (66 baseline + 18 mocked-transport), with "no test in the suite is a live API test" stated where counts are advertised. Historical cycle reports inside research-findings.md keep their original counts (history, not current advertising).

## D. Specification (frozen — errata only, NO text changed)

### C-19 — Spec §4.1: "`proration_date`/`effectiveDate`/`effective_from` pinning" attribution for Chargebee
- **Location:** spec/scq-v0.6.1-spec.md §4.1 (lines 277-289 at 5dbb9c7).
- **Original wording:** "Stripe's, Zuora's, and Chargebee's `proration_date`/`effectiveDate`/`effective_from` pinning already only ever computed the specific dimensions…"; "Chargebee's `effective_from`" listed as an EXACT mechanism ("a pure function of an explicit, caller-supplied instant").
- **Evidence/source:** C-02 — not established for the update endpoint.
- **Verdict:** not established.
- **Correction:** errata-proposed (ERRATA-PROPOSAL.md E-1). Spec text untouched per the Phase 2A hard constraint; `git diff 79200fa -- spec/` remains empty of normative change.

### C-20 — Spec §3.1 rationale + U-5: `end_of_term` vs `effective_from` as Chargebee's two mechanisms; DATE "verified-once"
- **Location:** spec §3.1 (line 96-97), §9 U-5 (lines 557-562) (at 5dbb9c7).
- **Original wording:** the distinction "is modeled, closing the v0.5-LIVE gap — but only ONE of the two mechanisms (`end_of_term`) was independently re-verified…; `effective_from` was verified via the original Experiment 2 pass only. Treat `DATE` support on Chargebee as verified-once".
- **Evidence/source:** DOCS — both update-endpoint scheduling paths are deprecated toward Early-Access Ramps; `effective_from` is a Ramps parameter, so "verified-once" overstates even the historical position for the update endpoint (what the historical cycle observed cannot be re-attributed to a parameter the current documented contract does not list for that endpoint).
- **Verdict:** deprecated-but-documented (`end_of_term` distinction); not established (`effective_from`-on-update, any verification level).
- **Correction:** errata-proposed (E-2, E-3). Spec text untouched.

### C-21 — Spec §6.9 / §8a: committed-term CANCEL UNKNOWN retraction
- **Verdict:** supported; unchanged; consistent with C-07/C-14.

### C-22 — Spec §6.10 idempotency rule vs implementation durability
- **Location:** spec §6.10; reference/src/store/quote-store.ts; live adapter T13.
- **Original wording (implementation-side):** receipt replay returns the original receipt with no time limit, implemented over an in-memory Map.
- **Evidence/source:** DOCS — native window is 30 minutes, with 422/409/5xx-cache semantics (audit A7); the store is volatile.
- **Verdict:** supported as a protocol rule for a conforming (durable-store) implementation; NOT ESTABLISHED for the reference implementation beyond process lifetime — previously implicit, now explicit.
- **Correction applied (implementation/docs only, no spec change):** durability-limit comments added to quote-store.ts, both adapters' commit paths, and the live adapter header; LIMITATIONS D-3 already stated the requirement and is cross-referenced. No indefinitely-safe idempotency is claimed anywhere after Phase 2A (grep-verified for "indefinitely"/"exactly-once" phrasing in adapter/store comments).

## E. Evidence register & research findings

### C-23 — EVIDENCE.md Chargebee summary: "Live test-site API + simulator" / "Estimate/commit agreement for tested cases; scheduling"
- **Location:** research/EVIDENCE.md summary table + items 1-8 (at 5dbb9c7).
- **Verdict:** items 2, 4, 6, 7, 8 supported as historical observations of the tested configurations; item 1 supported as a single-configuration observation (not a guarantee — see C-01); item 3 deprecated-but-documented as of current docs; item 5 UNVERIFIED (unchanged). The summary-row phrasing overstated currency/scope.
- **Correction applied:** summary row reworded to "Limited historical live test-site observations (v0.5-LIVE, prior cycle)"; a Phase 2A correction note appended to EVIDENCE.md scoping every item. The historical items themselves are not rewritten (they are the record).

### C-24 — research-findings.md v0.5 capability matrix (EXACT for every action; DATE EXACT; committed-term CANCEL EXACT "sharpest asymmetry"; "genuinely stronger than Stripe/Paddle")
- **Location:** research/research-findings.md v0.5 section (lines ~1259-1271 at 5dbb9c7) and v0.5-LIVE updated matrix (line ~1612: recurring "EXACT, but client-computed").
- **Verdict:** simulator-only / not established (financial + DATE rows); retracted already in v0.6 for the committed-term row; provider-favoring superlatives ("genuinely stronger", "sharpest asymmetry") are not evidence statements.
- **Correction applied:** findings are an append-only historical log, so the original text is NOT rewritten; a Phase 2A addendum section is appended at the end of research-findings.md superseding the Chargebee rows of both matrices and withdrawing the superlative framing. (The v0.5-LIVE "client-computed EXACT" phrasing is specifically superseded: client-side computation of a recurring total from known prices is normalization, not a provider guarantee — the live adapter's REVALIDATE posture governs.)

### C-25 — README / SUPPORT / CONTRIBUTING / preview docs: publication & Discussions status; "Live test-site API validation"
- **Location:** README.md:66-77,124,155; SUPPORT.md:7; CONTRIBUTING.md:11; docs/EXPERIMENTAL-PREVIEW.md:3 (at 5dbb9c7).
- **Original wording:** "Live test-site API validation" (README evidence table); "GitHub Discussions (once enabled)" (×3); "Prepared for a possible first public release; not yet published"; "the planned experimental preview".
- **Evidence/source:** tasking for Phase 2A (repository is already public; Discussions IS enabled) + C-23 for the evidence label. (The npm-package "not published" statements are accurate and are retained, now explicitly distinguished from repository publication.)
- **Verdict:** contradicted (publication/Discussions status); overstated (live-validation label).
- **Correction applied:** all reworded — repository described as published/public, Discussions as enabled, Chargebee evidence as "Limited historical live test-site observations (prior cycle only)", and EXPERIMENTAL-PREVIEW status rewritten to separate repository publication from npm non-publication and non-endorsement.

### C-26 — ACP-PRE-SEP silent-partial-application motivation (live Chargebee behavior)
- **Location:** standards/ACP-PRE-SEP.md:77,277; spec §6.8.
- **Verdict:** supported (HIST, EVIDENCE item 8). No correction. Its evidence-level sentence in ACP-PRE-SEP §"evidence" list ("live test-site API validation was performed for the testable scenarios") was reworded per C-25 to "limited historical live test-site observations … not a validation of the current adapters".

### C-27 — Live adapter claims (reference/src/live/*) — audited, retained
- **Claims:** REVALIDATE/REVALIDATE/UNKNOWN/REVALIDATE coverage; IMMEDIATE-only with TERM_END/DATE refused; BEST_EFFORT; `replace_items_list=true` + full list; `invoice_immediately=false`; quote-derived native idempotency key; lost-response reconcile-by-read; restart fail-closed (T13).
- **Evidence/source:** DOCS (audit A1-A9; recovery audit for the scheduled-change/mandatory-addon caveats).
- **Verdict:** supported as DOCUMENTATION_SUPPORTED + SIMULATED (mocked transport). Live behavior: BLOCKED (no credentials in either run) — no LIVE_* label is used for this adapter anywhere, enforced by Test 13-classifications.
- **Correction applied:** none to behavior. Header/comments strengthened in Phase 2A: explicit deprecated-vs-supported rationale for IMMEDIATE-only (Task 3), the durability limit (Task 6), and the scheduled-changes / mandatory-addons caveats with a pointer to RECOVERY-AUDIT.md (Task 4); `updateParams` now documents the mandatory-addon caveat at the exact call-construction site.

### C-28 — Atomicity claims, protocol-wide (ConsistencyGuarantee)
- **Claims in scope:** every adapter reports BEST_EFFORT; spec §3.6 ("no adapter … has ever reported, or may ever report, ATOMIC" for ConsistencyGuarantee).
- **Verdict:** supported (DOCS absence of CAS + HIST If-Match observation). No correction. MultiChangeConsistency ATOMIC is a distinct field — see C-09 for its narrowed scope.

### C-29 — Examples (examples/SCQ-EXAMPLES.md)
- **Audit result:** no Chargebee-specific capability claim appears in the examples (provider-neutral worked examples; the committed-term UNKNOWN example is generic). No correction. Listed here so the scope is closed explicitly rather than silently skipped.

---

## Summary of advertised capability after Phase 2A (simulator-backed Chargebee adapter)

| Dimension / intent | At 5dbb9c7 | After Phase 2A |
|---|---|---|
| immediateFinancialEffect | EXACT (all actions) | REVALIDATE (all actions) |
| recurringFinancialEffect | EXACT (all actions) | REVALIDATE (all actions) |
| termEffect (coarse) | EXACT (quantity) / UNKNOWN (others) | UNKNOWN (all actions) |
| termEffect (quote-level, evergreen CANCEL) | EXACT (within all-EXACT quote) | EXACT (dimension only; quote overall is REVALIDATE) |
| termEffect (quote-level, committed-term CANCEL) | UNKNOWN | UNKNOWN (unchanged) |
| effectiveAt | EXACT (all actions) | REVALIDATE (all actions) |
| supportedEffectiveIntents | IMMEDIATE, TERM_END, DATE (all actions) | IMMEDIATE (update actions); IMMEDIATE, TERM_END (CANCEL, deprecated-but-documented) |
| Overall EXACT request | honored for quantity / evergreen cancel | refused for every Chargebee action (names `immediateFinancialEffect`) |
| ConsistencyGuarantee | BEST_EFFORT | BEST_EFFORT (unchanged) |
| MultiChangeConsistency (qty+plan) | ATOMIC | ATOMIC, scoped to single-request bundling in the model |
