# Phase 2B Decision Package — Resolve Specification Contradictions and Prepare Publication

**Date: 2026-10-27** (America/Los_Angeles)
**Status: LOCAL ONLY.** Nothing pushed, no PR created, nothing merged to
main, no live Chargebee call made. Public publication is **not**
authorized; this package is the decision record for when it is.
**Inputs accepted:** Phase 2A's narrower Chargebee claims are the
working technical direction (maintainer decision, 2026-10-27).
**Branches/commits:**

| Ref | Commit | Content |
|---|---|---|
| `main` | `79200fa4cbcf955c618428c0fca74fd2abce7c9d` | Published baseline |
| `experiment/chargebee-live-validation-v1` (combined record) | `5dbb9c7` (Phase 1) → `7e993a3` (Phase 2A) → `a48ebb8` (Phase 2B) → this package's commit (tip) | All phases, combined |
| `review/change-a-evidence-spec-corrections` | `2ad9142e000ea17c1b7c6ce26b1de412101af946` + this package's file commit (tip) | Change A (19 files) |
| `review/change-b-live-validation-tooling` | `9317f33f2f80966037dd8ef298153a4765dff23d` | Change B (13 files) |

Partition proof: combined diff vs main = 32 files = Change A (19) +
Change B (13), **disjoint**, and each review branch's copies are
byte-identical to the combined branch's (diffing either review branch
against combined shows changes only in the *other* change's files).

---

## 1. Exact wording of the corrected specification claims

Full before/after text lives in `spec/ERRATA-v0.6.1.md` (dated
2026-10-27). Summary of each correction, verbatim in the errata package:

- **ER-1a (§4.1, was E-1):** "Stripe's, Zuora's, and Chargebee's
  `proration_date`/`effectiveDate`/`effective_from` pinning" →
  "Stripe's and Zuora's `proration_date`/`effectiveDate` pinning"
  (Chargebee removed from the EXACT mechanism attribution).
- **ER-1b (§4.1 bullet):** "(Zuora's `effectiveDate`, Chargebee's
  `effective_from`)" → "(Zuora's `effectiveDate`)".
- **ER-2 (§9 U-5, was E-3):** the "Treat `DATE` support on Chargebee as
  verified-once" entry is replaced wholesale (full text in the errata
  package): `end_of_term` is deprecated-but-documented; "DATE via
  `update_for_items` is NOT ESTABLISHED in the current documented
  contract"; both reference Chargebee adapters refuse DATE.
- **ER-3 (§3.1, was E-2):** "(`effectiveDate` vs `end_of_term=true`
  boolean vs `effective_from` timestamp on Chargebee specifically)" →
  "(`effectiveDate` on Zuora; historically an `end_of_term=true`
  boolean on Chargebee)".
- **ER-4 (§6.10, was E-5):** no original text replaced; a conformance
  note is **added** (full text in the errata package): a conforming
  live deployment requires durable persistence of quote, request
  identity, outcome, and receipt plus safe recovery after
  indeterminate outcomes; the in-memory `QuoteStore` does NOT establish
  the guarantee across crashes; Chargebee's documented native
  idempotency window is 30 minutes, not indefinite. §6.10's normative
  rule itself is unchanged and not weakened.

## 2. Factual errata vs genuinely normative

**All four errata are factual.** ER-1/ER-2/ER-3 correct what Chargebee's
documented contract contains and what this research verified; ER-4 is
documentation of an existing rule's presumption. Proof, run on a
disposable probe branch that applied ER-1…ER-4 in-spec (commit
`01fc584`, deleted after capture):

- MUST/MUST NOT token counts in `spec/scq-v0.6.1-spec.md`, main vs
  probe: **identical**.
- Diff of every line containing MUST/MUST NOT, main vs probe:
  **empty** (no normative line changed, added, or removed — ER-4's
  note deliberately introduces no MUST/MUST NOT).
- EXACT/REVALIDATE definitions, all API types, and the four supported
  change actions: unchanged (no diff in §3 type blocks, §4.1/§4.2
  definitions, or §1 action list beyond the quoted provider examples).

No exception to "all factual" was found. **E-4** (capability reporting
cannot express deprecated/early-access status) is explicitly **not**
classified as an erratum: it is a forward-looking design question,
carried open in the errata package §6/§7 and §5 below.

## 3. Remaining specification/adapter contradictions

1. **Spec file vs adapters (disclosed, bridged by the errata package):**
   the published `spec/scq-v0.6.1-spec.md` still contains the ER-1/ER-2/
   ER-3 wording. It remains until the freeze-guard label process
   (errata package §7) applies the errata in-spec, or a v0.6.2
   versioned correction folds them in. The errata package quotes both
   wordings, so the contradiction is on the record, not silent.
2. **Change B standalone vs corrected claims:** Change B alone builds
   and passes, but its tree retains the *original* simulator adapter and
   original Test 11 (pre-correction EXACT claims), because those files
   belong to Change A. B's own live adapter already encodes the
   corrected posture, and B's reports (TEST-RESULTS, REPRODUCTION,
   LIMITATIONS) cite Change A artifacts (`CLAIM-CORRECTION-MATRIX.md`,
   `ERRATA-PROPOSAL.md`) that are absent from B's tree. B is therefore
   internally consistent as code, but **not** claims-coherent as a
   standalone publication (see §6 recommendation).
3. **Taxonomy lives outside the capability object (E-4, open):** the
   four-class scheduling taxonomy (errata package §6) is expressed in
   the errata package, conformance doc, and adapter comments. The
   binary `supportedEffectiveIntents` type cannot express it; whether
   to add a status dimension is a future normative design decision,
   deliberately not taken here.
4. **Provider-side inconsistency (D-7, unresolved, not ours to fix):**
   Chargebee's own docs still disagree on the `end_of_term` deprecation
   target (estimate page vs update page).
5. **Documented limitations that remain limitations (not
   contradictions):** committed-term CANCEL is UNVERIFIED (U-1);
   Ramps is unimplemented; the reference `QuoteStore` provides no
   durable exactly-once (now documented in spec errata ER-4,
   conformance §6.10 note, `reference/README.md`, and the store header);
   the simulator does not model `replace_items_list` defaults or
   mandatory addons (labeled modeling gap). The 100→120→100 recovery
   procedure remains audited NOT COMPLETE (RECOVERY-AUDIT.md R-1…R-9);
   the corrected plan and test-site-discard fallback stand as Phase 2A
   left them.

## 4. Tests and validation outcomes

All runs local, credential-free, on clean `dist/` builds (a stale-dist
contamination was caught and corrected during Phase 2B validation:
branch counts below are from `rm -rf dist` runs).

| Check | Combined (`experiment/…-v1`) | Change A | Change B |
|---|---|---|---|
| Full suite `npm test` | **84 pass / 0 fail** | **66 pass / 0 fail** (test13 is Change B, correctly absent) | **84 pass / 0 fail** (66 original + 18 test13) |
| test11 separately | 10 pass / 0 fail | 10 pass / 0 fail (corrected assertions) | 10 pass / 0 fail (original assertions vs original adapter) |
| test13 separately | 18 pass / 0 fail | n/a (not in change) | 18 pass / 0 fail |
| `npm run smoke:pack` | OK (ESM import, TS consumer, tarball; nothing published) | OK | OK |
| Demo without credentials | prints `BLOCKED — CREDENTIALS NOT AVAILABLE`, no claims | n/a | prints `BLOCKED — CREDENTIALS NOT AVAILABLE`, no claims |
| Provider-neutrality CI check (`.github/workflows/provider-neutrality-check.yml` logic, run locally) | OK — no provider name in any declaration in `reference/src/core/types.ts` | OK | OK |
| Neutrality grep scan (provider-favoring language in `spec/`, `conformance/`, README, `docs/`, `reference/src/`) | No provider-favoring claim; 4 retained hits reviewed as non-favoring (generic rule in security-considerations; the retracted v0.5 phrase quoted to retract it; a pre-existing Zuora detection comment; an enforcement-timing phrase) — same disposition as Phase 2A | (same tree for scanned A files) | (same tree for scanned B files) |
| Spec-freeze guard (workflow logic simulated locally) | **PASS** — no change to `spec/scq-v0.6.1-spec.md`, `reference/src/core/types.ts`, or `reference/src/core/scq-engine.ts` vs main | **PASS** — same (the errata package is a new file, not a frozen file) | **PASS** — same |
| MUST/MUST NOT change (spec, vs main) | **None** (spec file untouched; probe proof in §2) | **None** | **None** (no spec change) |
| Secrets scan | No credentials/PII in tracked files (Phase 2A result re-confirmed by diff scope: Phase 2B adds docs/comments only) | — | — |

**Freeze-guard failure for the deliberate in-spec erratum (exact):**
applying ER-1…ER-4 to `spec/scq-v0.6.1-spec.md` on the probe branch and
running the workflow's own script logic locally (label check stubbed to
"no label", as a fresh PR would be) produced, exit code 1:

```
This PR modifies frozen protocol surface:
spec/scq-v0.6.1-spec.md

BLOCKED: this PR changes normative spec/core-engine surface but is not
labeled 'protocol-change-approved'. Per CONTRIBUTING.md, protocol changes
are made deliberately in response to a specific, discussed issue — link
that issue in the PR description, then have a maintainer apply the
'protocol-change-approved' label to unblock this check.
```

The guard was not disabled, edited, or bypassed in any branch. The
proposed narrow, auditable exception — use the guard's existing
`protocol-change-approved` label only for a PR whose sole frozen-surface
diff matches the errata package verbatim and attaches the zero-MUST-diff
proof, or defer in-spec application to a v0.6.2 versioned correction —
is specified in the errata package §7. No workflow change is proposed.

## 5. Local review branches and commits

See the table at the top of this package. Both review branches are
based directly on `main` (`79200fa`), are unmerged and unpushed, and
the original experiment branch is intact as the combined record.
Working trees are clean on all three branches (checkout ends on the
combined branch).

## 6. Recommendation — publish sequentially: A first, then B; not together, never B before A

**Do not publish both changes as one combined PR, and do not publish
B before A.** Recommended sequence, once publication is authorized:

1. **Change A first.** It only narrows claims to documented evidence,
   adds the dated errata package, and touches no frozen file — it
   passes the freeze guard as-is and needs only ordinary maintainer
   review. After A, the public tree's simulator claims, conformance
   rows, and evidence labels are correct, and the spec/adapter
   contradiction is bridged by the published errata package.
2. **Change B second.** B is build-independent (84/84 standalone — no
   silent breakage), but it is *documentation-dependent* on A: its
   validation reports cite A's claim matrix and errata, and its live
   adapter's corrected posture is only coherent against A's corrected
   simulator claims. Merged after A, every cross-reference resolves and
   no interim public state mixes corrected and uncorrected Chargebee
   claims. Merged alone or first, the public tree would temporarily
   carry B's reports describing corrections that are not in the tree,
   alongside the still-uncorrected simulator adapter.
3. **In-spec errata application stays a third, separate step** (labeled
   PR per errata §7, or the v0.6.2 correction), so the freeze guard's
   audit trail is never entangled with either change's review.

Publishing A and B "together" as two sequential PRs in that order is
safe; publishing them as a single combined PR is not recommended
because it would merge experimental tooling and evidence corrections
under one review, which is exactly the conflation the two-change split
exists to prevent.
