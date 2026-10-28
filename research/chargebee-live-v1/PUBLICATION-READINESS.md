# Publication Readiness — Phase 2A Chargebee Evidence Correction

Date: 2026-10-27. Branch: `experiment/chargebee-live-validation-v1`
(local only — nothing in Phase 2A was pushed, published, or posted).
Base: Phase 1 commit `5dbb9c7` on `79200fa` (main).

**Context that governs this split:** SCQ is ALREADY a public
repository and GitHub Discussions IS enabled. "Publication" below
therefore means *merging this local branch's corrections into the
public repo's main line* — not a first release. The npm package
remains unpublished (`private: true`) and nothing here changes that.

## Verification gates (all run locally in Phase 2A, after corrections)

| Gate | Result |
|---|---|
| `cd reference && npm test` (full suite) | **84 pass / 0 fail** (66 baseline incl. corrected Test 11 + 18 test13; total unchanged from Phase 1 — assertions changed, no tests added/removed) |
| test13 separately (`node --test dist/tests/test13-chargebee-http.test.js`) | **18 pass / 0 fail** |
| test11 separately | **10 pass / 0 fail** (all with corrected assertions) |
| `npm run smoke:pack` | **OK** — external ESM import OK, external TS consumer OK, tarball smoke OK (nothing published) |
| Tests with credentials explicitly absent (`env -u CHARGEBEE_*`) | **84 pass / 0 fail** |
| Live demo driver without credentials | prints `BLOCKED — CREDENTIALS NOT AVAILABLE`, claims nothing |
| Spec-freeze guard: `git diff 79200fa -- spec/` | **empty** (also empty vs 5dbb9c7) — no normative change |
| Other providers | **untouched** — no Stripe/Paddle/Zuora file in the Phase 2A diff; `reference/src/core/` also untouched |
| Neutrality check | No neutrality script exists in `reference/package.json` (scripts: build/test/demo/demo:commit/smoke:pack), so a grep-based scan was run and is documented below |
| Secrets scan | No credentials. The only `apiKey` literals in the tree are the pre-existing `test_key_redacted` placeholders in test13's fake-transport setup (not a credential; file unchanged by Phase 2A) |

> **Count attribution (PR #3 review fix):** every count in the table
> above is for the **combined branch** named in this report's header
> (66 baseline + test13's 18 = 84, including the test13-only and
> live-demo rows — test13 and the live adapter belong to the pending
> Change B). **Change A**, into which this record is copied, contains
> only the 66-test suite; Change A's public docs state 66 for this
> change and attribute 84 explicitly to the combined branch / Change B.

### Neutrality scan (grep-based, documented per Phase 2A Task 7)

Scope scanned: `spec/`, `conformance/`, `README.md`, `docs/`,
`reference/src/`, `reference/README.md` for provider-favoring language
(`stronger than`, `genuinely stronger`, `sharpest`, `strongest`,
`superior`, `Chargebee is stronger`, comparative constructions around
provider names). Findings after Phase 2A:

- **No provider-favoring capability claim remains in normative-adjacent
  docs or Chargebee code.** The v0.5-era superlatives ("genuinely
  stronger than Stripe/Paddle", "sharpest asymmetry") survive ONLY in
  `research/research-findings.md`'s append-only historical sections,
  where the appended Phase 2A addendum explicitly supersedes and
  withdraws them; research history is not normative-adjacent.
- Retained hits, each reviewed and NOT provider-favoring:
  `spec/security-considerations.md` ("must not advertise a guarantee
  stronger than actual enforcement can deliver" — a generic normative
  rule); `chargebee-adapter.ts` (the phrase "Chargebee is stronger
  than Zuora here" appears only inside the v0.6 correction comment
  QUOTING the retracted v0.5 claim in order to retract it);
  `chargebee-scq-adapter.ts` ("stronger than the spec's floor" — about
  enforcement timing, not a provider); Zuora adapter/sim comments
  ("genuinely stronger" about Zuora's documented native version field
  for DETECTION) — pre-existing, other-provider files, out of Phase
  2A's scope per its constraints, and factually scoped to detection
  vs. atomicity in the same sentences.

## A. Safe to merge into the public repo as-is (no spec change involved)

These are adapter/test/docs corrections that bring advertised claims
DOWN to the existing evidence. None alters SCQ v0.6.1 semantics; the
frozen spec is untouched.

1. `reference/src/adapters/chargebee-adapter.ts` — coverage corrected
   to REVALIDATE/REVALIDATE/UNKNOWN/REVALIDATE; DATE refused (all
   actions); TERM_END refused for update-backed actions, retained for
   CANCEL as deprecated-but-documented; pinning rationale removed;
   durability limit stated at the commit path.
2. `reference/src/adapters/chargebee-sim.ts` — header/comment
   corrections only (sim arithmetic unchanged): `effective_from`
   relabeled simulator-only, `?estimate=true` framing removed,
   committed-term EXACT asymmetry retracted, proration⇒EXACT
   reasoning retracted. No behavior change.
3. `reference/tests/test11-chargebee.test.ts` — assertions rewritten
   per CLAIM-CORRECTION-MATRIX §C (11a, 11b, 11c, 11d, 11e, 11g, 11h,
   11i title, 11j). Suite total unchanged (84 on the combined branch;
   Change A's suite is 66).
4. `reference/src/live/chargebee-scq-adapter.ts`,
   `reference/src/store/quote-store.ts` — comments only (IMMEDIATE-only
   rationale, durability limits, scheduled-change/mandatory-addon
   caveats). No behavior change.
5. Public-release wording: `README.md`, `SUPPORT.md`,
   `CONTRIBUTING.md`, `docs/EXPERIMENTAL-PREVIEW.md`,
   `.github/pull_request_template.md`, `standards/ACP-PRE-SEP.md`,
   `standards/STANDARDS-RECOMMENDATION.md` — repository published /
   Discussions enabled / limited-historical-evidence labels / test
   counts (84 on the combined branch; stated as 66 for Change A after
   the PR #3 review fix).
6. `conformance/conformance.md` — Chargebee rows updated to the
   corrected tests; counts updated; Phase 2A note added.
7. `research/EVIDENCE.md` — summary row tempered + Phase 2A correction
   note appended (historical items not rewritten).
8. `research/research-findings.md` — Phase 2A addendum appended
   (append-only; supersedes listed historical claims).
9. `research/chargebee-live-v1/` — CLAIM-CORRECTION-MATRIX.md,
   RECOVERY-AUDIT.md, ERRATA-PROPOSAL.md, this file (new);
   LIMITATIONS-AND-GAPS.md D-1/D-2/D-5 status updates;
   TEST-RESULTS.md recovery correction + Phase 2A re-run record;
   REPRODUCTION.md freeze-check wording.

**Merge gate for A:** ordinary maintainer review of the branch diff.
No external approval is needed to *narrow* claims; the changes assert
strictly less than the public repo currently asserts.

## B. Requires a separately reviewed SCQ spec revision (do NOT merge as spec text)

All items in ERRATA-PROPOSAL.md, against the frozen
`spec/scq-v0.6.1-spec.md`:

- **E-1** (§4.1): remove the `effective_from` pinning attribution for
  Chargebee from the EXACT mechanism list. HIGH.
- **E-2** (§3.1): annotate the `end_of_term`/`effective_from`
  rationale as historical + deprecated/current status. MEDIUM.
- **E-3** (§9 U-5): replace "DATE verified-once" with NOT ESTABLISHED
  for `effective_from`-on-update; TERM_END as
  deprecated-but-documented. HIGH.
- **E-4** (design question): whether capability reporting should
  express deprecated/early-access status, or ratify the binary model
  with a must-not-advertise-deprecated rule. LOW / forward-looking.
- **E-5** (§6.10): state the durability presumption (or process-
  lifetime scoping) for receipt replay. MEDIUM.

**Gate for B:** a dedicated spec-revision cycle (v0.6.2 errata or
v0.7) with its own review and approval, per the repo's protocol-freeze
process (the PR template's `protocol-change-approved` path). Until
then, the public spec and the public adapters disagree in exactly the
ways E-1/E-3 describe, and CLAIM-CORRECTION-MATRIX.md is the bridging
record. That disagreement is disclosed, not hidden: the matrix and
this file are part of the mergeable set A.

## C. Claims that remain unsupported (not mergeable as claims in any form)

1. **EXACT financial coverage for Chargebee** on any action, by any
   mechanism currently documented for the estimate→update pair.
   Status: NOT ESTABLISHED (not "disproven everywhere").
2. **DATE scheduling via `update_for_items`** — not established;
   the documented current path (Ramps) is Early Access, site-gated,
   unimplemented, and unvalidated on any specific site.
3. **TERM_END via `update_for_items`** as a *supported* (current)
   capability — deprecated-but-documented only. (CANCEL's TERM_END is
   retained in the simulator adapter under that exact label.)
4. **Committed-term CANCEL semantics** (incl. any early-termination
   fee derivation) — UNVERIFIED; no Contract-Terms-enabled site has
   ever been available to this research.
5. **Durable exactly-once / indefinitely-safe idempotency** — the
   in-memory QuoteStore + 30-minute native window cannot provide it;
   a durable transactional store is required and does not exist here.
6. **The 100→120→100 procedure as a complete recovery** — audited
   NOT COMPLETE (RECOVERY-AUDIT.md R-1…R-9). Only wholesale discard
   of a disposable test site is unconditionally complete.
7. **Any LIVE_* result for the Phase 1 / Phase 2A runs** — both runs
   had no credentials; every live row is BLOCKED. The only live
   evidence in the repo remains the limited historical v0.5-LIVE
   observations, scoped per EVIDENCE.md + its Phase 2A note.
8. **Second-provider live portability** — unchanged from Phase 1:
   Stripe/Paddle/Zuora remain documentation-backed simulations.

## Approval gates summary

| Gate | For what | Status |
|---|---|---|
| Maintainer review of this branch | Merging set A into the public repo | PENDING (nothing pushed in Phase 2A) |
| Separate spec-revision approval | Any ERRATA-PROPOSAL item (set B) | NOT REQUESTED by Phase 2A; proposals recorded only |
| Explicit live-experiment approval (exact operations named) | Any future credentialed read/estimate run, and separately any single live commit | NOT REQUESTED; all live work remains BLOCKED |
| Recovery-plan adoption | Using RECOVERY-AUDIT.md's corrected plan in a future live run | Part of the live-experiment approval above; the original TEST-RESULTS procedure is withdrawn |
| npm publication | The reference package | NOT PROPOSED; `private: true` unchanged |

---

## Phase 2B update (2026-10-27) — supersedes the Set A / Set B framing above where they differ

Phase 2A's narrower Chargebee claims were accepted by the maintainer as
the working technical direction. Public publication is still **not**
authorized. Phase 2B reorganizes the combined work into two separately
reviewable local changes and resolves the Set B errata as a dated
package:

- **Errata resolved as a package, not as in-spec edits:**
  `spec/ERRATA-v0.6.1.md` (ER-1 = E-1, ER-2 = E-3, ER-3 = E-2,
  ER-4 = E-5) gives exact before/after wording for every correction.
  The published spec file remains unchanged in Phase 2B because
  applying the errata in-spec trips the protocol freeze guard; the
  guard's exact failure output and a narrow, label-based exception
  process are recorded in the errata package §7 and the Phase 2B
  decision package. E-4 remains an open design question, not an
  erratum.
- **Change A — Evidence and specification corrections** (local branch
  `review/change-a-evidence-spec-corrections`): simulator capability
  corrections, corrected assertions, documentation/evidence wording,
  the dated errata package, and this research record set.
- **Change B — Experimental live validation tooling** (local branch
  `review/change-b-live-validation-tooling`): the isolated live HTTP
  adapter, demo, mocked-transport test13, and the validation reports.
- Full per-branch validation, the remaining contradictions, and the
  publish-together recommendation are in
  `research/chargebee-live-v1/PHASE-2B-DECISION-PACKAGE.md`.

Set B above should now be read as: "resolved as dated errata in
`spec/ERRATA-v0.6.1.md`; in-spec application awaits the freeze-guard
label process or a v0.6.2 versioned correction." Nothing in this
update authorizes pushing or merging either change.
