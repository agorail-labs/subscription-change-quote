# Migration Guide — experimental.1 → stable candidate

For consumers of `@agorail-labs/scq-reference@0.6.2-experimental.1`
moving to the stable candidate (1.0.0-rc.1, prepared — not yet
released). Everything here is verified against the source and the
published artifact; where behavior differs, both sides are stated.

## 1. Node.js >= 22 is required

The candidate declares `engines: node >=22` and is validated on
Node 22, 24, and 26 LTS. Node 20 is end-of-life and is not
supported. **Known published-artifact caveat:** the experimental
package's optional `better-sqlite3@^11` cannot be installed on
Node 26 (no prebuild; source build fails on removed V8 APIs), so
with the *published* package the durable store is usable on Node
22/24 only. The candidate moves to `better-sqlite3@^13`, which
restores Node 26 (verified by clean-install suite and consumer
runs). If you run the published package on Node 26 today, use the
in-memory `QuoteStore` or pin Node 24 — do not paper over a
`DurableStoreError`.

## 2. Acceptance-envelope field naming (Issue #64)

- Published: bounds are `maxImmediateNetIncrease`,
  `maxImmediateCreditDecrease`, `maxRecurringIncrease`.
- Candidate: the canonical name is **`maxImmediateNetDecrease`**
  (it bounds the signed `immediate.net` decrease in all cases,
  including credit growth and cross-zero moves, where "credit
  decrease" was a misnomer). `maxImmediateCreditDecrease` is
  accepted as a **deprecated alias with identical semantics**.
- Supplying **both spellings in one envelope is refused as
  ambiguous** — pick one.
- Acceptance math, bound defaults (absent bound = zero tolerance),
  and violation codes are unchanged. Stored quotes/receipts are
  never rewritten; the alias resolves at read/compare time.

## 3. Durable-store schema v5 (Issues #51/#45)

- Opening a pre-v5 database with the candidate migrates its
  evidence **append-only**: legacy evidence is preserved and
  re-verified, never edited in place. Verified recovery cannot be
  fabricated by migration (test63).
- Dispatch exclusion is namespaced: an intent claimed under one
  tenant/provider/site namespace cannot be replayed or settled
  under another (test64). If you shared one database across
  namespaces experimentally, expect cross-namespace replays to be
  refused — that refusal is the fix, not a regression.

## 4. What did not change

- Export names: identical (22 values, 69 types — machine-checked
  against the published artifact).
- Quote/commit/receipt semantics, determinacy gate, envelope math,
  replay behavior, error codes.
- The package remains ESM, root-exports only. `ScqEngine` remains
  internal; the supported commit path is coordinator + adapter.

## 5. Deliberately not migrated

- The MSE–SCQ bridge stays source-only and experimental; it is not
  part of the candidate package.
- The live Chargebee pilot stays excluded from the tarball. There
  is still no supported live dispatch.
