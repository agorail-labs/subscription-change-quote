# Errata Proposal — SCQ v0.6.1 Specification (Chargebee attributions)

**Status: PROPOSAL ONLY — nothing in this document changes the spec.**
`spec/scq-v0.6.1-spec.md` is frozen at v0.6.1 and was NOT modified by
Phase 2A (verified: `git diff 79200fa -- spec/` shows no change). The
items below are inaccuracies or stale attributions that Phase 2A found
in normative-adjacent spec text. Each requires a **separately reviewed
SCQ spec revision** (a v0.6.2 errata release or a v0.7 cycle) with its
own approval — they must not be folded into an adapter/docs merge.

Language discipline (applies to every item): undocumented
`effective_from` financial pinning is **NOT ESTABLISHED**. No erratum
below asserts that no equivalent mechanism exists anywhere in
Chargebee's products; each asserts only what the current documented
Product Catalog 2.0 contract for the named endpoint does and does not
contain, per the Phase 1 audit (docs re-read 2026-10-27) and the
Phase 2A recovery audit.

---

## E-1 — §4.1 EXACT mechanisms list attributes `effective_from` pinning to Chargebee's update path

- **Current text (§4.1):** "No adapter's actual EXACT mechanism
  changed — Stripe's, Zuora's, and Chargebee's
  `proration_date`/`effectiveDate`/`effective_from` pinning already
  only ever computed the specific dimensions…"; and "Having
  order/estimate math that is inherently a pure function of an
  explicit, caller-supplied instant rather than ambient 'now'
  (Zuora's `effectiveDate`, Chargebee's `effective_from`)."
- **Problem:** `effective_from` is not a documented parameter of
  `update_for_items`; it is the required parameter of Create-a-ramp.
  As written, §4.1 names a mechanism for Chargebee EXACT that the
  documented contract does not establish, and implies a Chargebee
  adapter can back EXACT the way Zuora's `effectiveDate` backs it.
  After Phase 2A no Chargebee adapter in this repo claims EXACT for
  any financial dimension (the one remaining quote-level EXACT is
  evergreen CANCEL's `termEffect`, which no pinning mechanism backs;
  overall EXACT is refused for every action because the financial
  dimensions are REVALIDATE), so the spec's mechanism list and the
  reference implementation now disagree.
- **Proposed revision (for the spec-revision cycle to wordsmith):**
  remove Chargebee from the pinning-mechanism list in §4.1; add a
  note that Chargebee's documented estimate→update pair has no
  established pinning mechanism, that the reference Chargebee
  adapters therefore report REVALIDATE for the financial dimensions,
  and that a future Ramps-based adapter would need its own evidence
  before any EXACT claim. Do NOT replace the attribution with a claim
  that Chargebee has no pinning mechanism of any kind anywhere.
- **Severity:** high — normative-adjacent mechanism attribution for a
  guarantee dimension.

## E-2 — §3.1 rationale presents `end_of_term` / `effective_from` as Chargebee's two current mechanisms

- **Current text (§3.1):** "three semantically and mechanically
  different requests that, on Zuora and Chargebee, invoke different
  native code paths (`effectiveDate` vs `end_of_term=true` boolean vs
  `effective_from` timestamp on Chargebee specifically)."
- **Problem:** both Chargebee mechanisms named are, in current docs,
  deprecated (update-endpoint scheduling, toward Ramps) or not
  parameters of that endpoint at all (`effective_from`). The rationale
  is historically accurate for why the schema was designed, but reads
  as a statement about the current API.
- **Proposed revision:** annotate the rationale as historical design
  context and add a current-status note: update-endpoint scheduling
  paths are deprecated in favor of Ramps (Early Access); SCQ's
  `EffectiveIntent` union itself is unchanged (the schema distinction
  remains valid — providers differ in whether/how they honor it, which
  is what `supportedEffectiveIntents` + refusal is for).
- **Severity:** medium — rationale text, not a normative rule, but it
  is the sentence future implementers will cite for DATE support.

## E-3 — §9 U-5: DATE support on Chargebee described as "verified-once"

- **Current text (U-5):** "only ONE of the two mechanisms
  (`end_of_term`) was independently re-verified against a fresh,
  isolated raw request/response pair during v0.5-LIVE;
  `effective_from` was verified via the original Experiment 2 pass
  only. Treat `DATE` support on Chargebee as verified-once, not
  extensively-verified."
- **Problem:** "verified-once" still asserts a verification level for
  a parameter the current documented contract does not list for that
  endpoint. Whatever the historical session observed, the spec should
  not carry a verification grade for `effective_from`-on-update.
- **Proposed revision:** reword U-5 to: the `end_of_term` mechanism
  was re-verified historically and is now deprecated-but-documented;
  DATE-via-update is NOT ESTABLISHED in the current documented
  contract (the documented current path is Ramps, Early Access,
  unimplemented and unvalidated here); both reference Chargebee
  adapters refuse DATE. Keep the historical Experiment 2 record in
  research-findings.md (with the Phase 2A addendum), not as a spec
  verification grade.
- **Severity:** high — an unresolved-issues entry that integrators
  read as a support statement.

## E-4 — Capability model has no way to express deprecated / early-access status (design question, not an erratum of fact)

- **Observation:** `supportedEffectiveIntents` is binary. Phase 2A's
  adapter-level resolution — refuse deprecated-but-documented intents
  and say why in comments/docs — is honest but invisible in the
  capability object itself. A future spec cycle should DECIDE whether
  SCQ wants a status dimension (e.g. current / deprecated /
  early-access) on capability reporting, or explicitly ratify the
  binary model with a rule that deprecated mechanisms MUST NOT be
  advertised as supported. Phase 2A proposes no schema change and the
  frozen spec is not wrong about its own model — this is recorded so
  the question is not lost.
- **Severity:** low / forward-looking.

## E-5 — §6.10 idempotency rule: no durability requirement on the store (gap between rule and conformance)

- **Observation:** §6.10 requires returning the original receipt on
  repeated commit, checked before any provider read. The spec does
  not state a durability requirement for the store that makes this
  possible across restarts, and the reference implementation's
  in-memory store cannot satisfy the rule across a restart (it fails
  closed instead — the safe direction, but not conformance).
  LIMITATIONS D-3 already specifies what a conforming deployment
  needs (durable transactional store, native-key + parameter
  retention, post-window policy).
- **Proposed revision:** in the spec-revision cycle, either (a) add a
  conformance note to §6.10 stating the rule presumes a durable
  quote/receipt store and that in-memory implementations are
  non-conforming for replay-across-restart, or (b) explicitly scope
  §6.10 to a single process lifetime. Phase 2A takes no position on
  which; it only records that the current text + current
  implementation, read together, overclaim.
- **Severity:** medium — conformance-relevant.

## Items reviewed and NOT proposed as errata

- §6.9 (committed-term CANCEL UNKNOWN): accurate; stands.
- §3.6 / §6.8 (BEST_EFFORT-only consistency; silent-partial-execution
  rule): accurate against current docs + historical observation;
  stand.
- §4.2 REVALIDATE clarifications: accurate; the live adapter's
  behavior conforms (envelope against last pre-mutation preview).
- Security considerations (spec/security-considerations.md):
  Chargebee-relevant statements re-read in Phase 2A; no Chargebee
  capability attribution requiring errata was found there.
