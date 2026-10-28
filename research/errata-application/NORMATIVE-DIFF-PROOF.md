# Normative-Diff Proof — In-Spec Errata Application (ER-1…ER-4)

**Branch:** `review/errata-application-v0.6.1`
**Base:** `9748e03daff4059a1a78eb8c14e98ceefba80fdc` (main at the PR #4 merge)
**Subject:** applying `spec/ERRATA-v0.6.1.md` entries ER-1…ER-4 to
`spec/scq-v0.6.1-spec.md`, plus the revision-history entry the errata
package prescribes verbatim in its §5.
**Companion check script:** `research/errata-application/check_normative_diff.py`
(re-runnable; run from the repository root).

## Result summary

**No normative obligation changed.** The wrap-joined multiset of
obligation-bearing lines (lines containing MUST, MUST NOT, SHALL,
SHALL NOT, or REQUIRED) is identical between base and branch except for
exactly **one added line**, itemized below, which is the §5-prescribed
revision-record entry *about* the errata — it states that no obligation
changed and imposes none itself. Zero obligation lines were removed or
modified. The frozen core files are byte-identical, and every
TypeScript type fence in the spec is unchanged.

## Commands and outputs

```
$ python3 research/errata-application/check_normative_diff.py
== Check 1: obligation-line multiset (base 9748e03daff4 vs working tree) ==
base obligation lines: 27 | branch obligation lines: 28
removed: 0 | added: 1
  ADDED:   > **Errata 2026-10-27 (factual corrections only — no normative
           change):** §4.1 no longer attributes an `effective_from` pinning
           mechanism to Chargebee (ER-1); §9 U-5 no longer characterizes
           Chargebee DATE support as verified-once — DATE via
           `update_for_items` is NOT ESTABLISHED in the current documented
           contract and `end_of_term` is deprecated-but-documented (ER-2);
           §3.1's rationale examples are marked historical (ER-3); §6.10
           gains a conformance note documenting the durable-persistence
           presumption of the idempotency rule (ER-4). Full before/after
           wording: `spec/ERRATA-v0.6.1.md`. No MUST/MUST NOT, type,
           definition, or supported action changed.
== Check 2: obligation token counts ==
  MUST NOT   base=13 branch=14
  MUST       base=54 branch=56
  SHALL NOT  base=0 branch=0
  SHALL      base=0 branch=0
  REQUIRED   base=1 branch=1
== Check 3: frozen core files byte-identical ==
  reference/src/core/types.ts: IDENTICAL
  reference/src/core/scq-engine.ts: IDENTICAL
== Check 4: spec TypeScript fences identical ==
  ts fences: base=9 branch=9 identical=True
RESULT: PASS (checks 3-4 exact; check 1 differences itemized above)
```

## Itemization of the single differing line

- **Added line:** the §8c revision-record entry ("Errata 2026-10-27
  (factual corrections only — no normative change): … No MUST/MUST NOT,
  type, definition, or supported action changed.").
- **Prescribed by:** errata package §5, which instructs that this exact
  entry be added to the spec's revision record (§8 area) verbatim when
  ER-1…ER-4 are applied, with §8's existing tables otherwise unaltered.
- **Why it is not an obligation change:** the line is a dated
  revision-history *statement about* the errata. It has no deontic
  subject — it requires nothing of any adapter, implementation, or
  caller. Its MUST/MUST NOT tokens occur inside the sentence "No
  MUST/MUST NOT, type, definition, or supported action changed," which
  *reports* the absence of obligation changes; the token deltas in
  Check 2 (MUST +2, MUST NOT +1) are entirely attributable to this
  sentence. Every line that actually states a rule — including all of
  §6 — is present, unmodified, in both multisets.
- **Removed lines:** none. **Modified obligation lines:** none.

## What the application changed (complete spec diff, by errata item)

| Item | Location | Change |
|---|---|---|
| ER-1a | §4.1 paragraph | Chargebee removed from the `proration_date`/`effectiveDate`/`effective_from` pinning attribution (Stripe and Zuora remain) |
| ER-1b | §4.1 mechanism bullet | "(Zuora's `effectiveDate`, Chargebee's `effective_from`)" → "(Zuora's `effectiveDate`)" |
| ER-2 | §9 U-5 | "verified-once" characterization withdrawn; replaced with the errata package's corrected U-5 text (DATE via `update_for_items` NOT ESTABLISHED; `end_of_term` deprecated-but-documented) |
| ER-3 | §3.1 rationale | Provider examples marked historical: "(`effectiveDate` on Zuora; historically an `end_of_term=true` boolean on Chargebee)" |
| ER-4 | §6.10 | Conformance note appended verbatim (documentation only; contains no MUST/MUST NOT and does not reword the rule) |
| §5 supplement | §8c (new) | Revision-record entry added verbatim, as the errata package prescribes; §8a/§8b tables unaltered |

Replacement wording is the errata package's corrected wording in every
case (line-wrap normalized to the spec's column width, as the package's
own quotations are).

## Freeze-guard status (expected)

This branch intentionally modifies `spec/scq-v0.6.1-spec.md`, which is
on the freeze guard's frozen-surface list
(`.github/workflows/protocol-freeze-guard.yml`). Run locally, the
guard's detection step

```
git diff --name-only <base> <head> -- spec/scq-v0.6.1-spec.md \
  reference/src/core/types.ts reference/src/core/scq-engine.ts
```

returns exactly `spec/scq-v0.6.1-spec.md` (the two core files are
byte-identical — Check 3). The corresponding PR is therefore expected
to **fail the freeze guard until a maintainer applies the
`protocol-change-approved` label**, per the errata package §7 process.
The guard was not edited, disabled, or bypassed, and no label has been
applied by the author of this branch.
