# Sample preflight run — MOCKED (SIMULATED evidence)

Produced 2026-10-29 by `npm run preflight:chargebee -- --out <this
directory>` on the PR-11 branch; REGENERATED 2026-10-30 under the
PR #20 review corrections (PF1–PF3) on the same branch: the
canonical pilot fixture quote (addon `pilot-addon-vision` quantity
1 → 21 on `pilot-sub-001`, site `pilot-test`) in a temporary durable
database, over the mocked Chargebee transport, preceded by the
mocked recovery rehearsal (14/14 scenarios, SIMULATED_PASS).

- `preflight.json` / `preflight.md` — the sanitized report pair.
- Overall: **NO-GO**, as designed: condition 1 UNVERIFIED (no
  release-approval record), condition 2 PASS on SIMULATED rehearsal
  evidence, condition 3 UNVERIFIED (caller-supplied mocked
  transport — no real-tenant evidence), condition 4 BLOCKED (no
  reconciliation owner named), condition 5 BLOCKED (no separate
  commit authorization).
- Transport provenance is reported as `injected`: since PF1 it is
  structural — a caller-supplied transport is always simulated
  evidence, and only the preflight's own internally constructed
  guarded network transport can be classified `real`. Nothing in
  this run is, or can be relabeled as, live evidence.
- Quote-origin binding (PF3): the CLI recorded the fixture quote's
  origin at issuance (site from its own configuration) in the
  origin manifest, and the report's binding is ESTABLISHED from
  that record — `siteBindingOk` / `subscriptionMatch` are derived
  from the issuance record, not from caller expectations. A quote
  without an origin record would BLOCK.
- No operator attestation flag was passed, so tenant mode is
  UNVERIFIED in the report even though the fixture is synthetic.
- Observed transport: 4 dispatched calls, all read-only/estimate;
  0 mutating; `update_for_items` dispatched 0 times.
- Nothing in this directory is live evidence, and no real Chargebee
  tenant was contacted.
