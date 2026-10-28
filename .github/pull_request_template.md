<!--
Before opening this PR, please read CONTRIBUTING.md. SCQ v0.6.1 is a frozen
protocol version under external review — the spec, reference implementation,
and test suite are not being actively redesigned while feedback is collected.
-->

## What does this PR do?

<!-- One or two sentences. -->

## Related issue

<!-- Link the issue this PR addresses. Feedback is triaged as issues first;
     a PR without a linked issue is unlikely to be merged, especially if it
     touches spec/ or reference/src/core/. -->

Closes #

## Does this touch frozen protocol surface?

<!-- spec/scq-v0.6.1-spec.md, reference/src/core/types.ts, or
     reference/src/core/scq-engine.ts. If yes, this PR needs the
     `protocol-change-approved` label (see .github/workflows/protocol-freeze-guard.yml)
     and should reference the discussion/issue where the change was agreed on. -->

- [ ] No — this PR only touches adapters, tests, docs, or tooling.
- [ ] Yes — linked issue/discussion: 

## Evidence level (if this PR asserts anything about provider behavior)

<!-- Per research/EVIDENCE.md: LIVE_API_VALIDATED / DOCUMENTATION_BACKED_SIMULATION /
     INFERRED / UNVERIFIED. Only Chargebee has live API validation in this project. -->

## Checklist

- [ ] `cd reference && npm test` passes locally (66+ tests)
- [ ] No new provider name introduced in `reference/src/core/types.ts` (provider-specific logic stays in `reference/src/adapters/*`)
- [ ] Docs updated if behavior, evidence level, or scope changed
