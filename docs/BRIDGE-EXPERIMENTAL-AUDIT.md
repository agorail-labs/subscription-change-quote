# Source-only MSE–SCQ Bridge — Experimental Audit

**Subject:** `reference/src/integration/business-intent-bridge.ts`
(`BusinessIntentLedger`, `MseScqIntentBridge`; PR #69). **Status:
EXPERIMENTAL — excluded from the proposed stable core** (see
`docs/STABLE-RELEASE-READINESS.md` §2.3). It is not exported from
the package entry and is excluded from the published tarball
(`src/integration/` in the package `files` exclusions). This audit
records the Phase 3 review outcome per question; nothing here
promotes the bridge.

| Question | Finding | Evidence |
|---|---|---|
| Tenant/provider/site namespace isolation | Claims are keyed `(tenant_id, intent_id)` with a binding digest over tenant, provider, site, subscription, and operation; a reused intent identity with a different binding is a `BusinessIntentConflict`, never an overwrite. Cross-namespace durable dispatch exclusion is separately enforced in the store (#45). | bridge source `identityOf` / ledger schema; test62, test64 |
| Business-intent identity | Identity is caller-supplied `(tenantId, businessIntentId)` plus the canonical-JSON binding digest; ambiguous/non-plain-JSON operations are refused at the boundary. Identity *authenticity* is out of scope — the ledger records claims, it does not authenticate claimants. | bridge source lines 18–76 |
| Authorization provenance | The bridge records the admission gate's decision alongside the claim (`admission_json`); it does not itself authorize. Provenance is *recorded*, not *verified* — a caller that bypasses the gate and writes the ledger directly is outside the bridge's enforcement. Acceptable for an experimental component; a stable promotion would need the gate to be non-bypassable. | ledger schema; test62 |
| Admission evidence authenticity | Same posture as SCQ core limitation G-01: evidence is trusted once established by the caller's evaluator; the bridge does not authenticate MSE evidence origin. | readiness doc §2.4 |
| Separate SQLite ledger crash gaps | The bridge ledger and the SCQ durable store are **separate SQLite databases with no cross-database transaction**. A crash between the claim write and the SCQ attempt write leaves a claim with no attempt (or vice versa). test67 (process-kill) exercises the bridge's own recovery posture, but no atomicity across the two ledgers exists or is claimed. **This is the principal technical blocker to any stability promotion.** | test67; architecture inspection |
| Indefinitely blocked orphan claims | A claim whose SCQ execution never begins has no TTL or expiry in the ledger; it blocks intent reuse until manual intervention. Fail-closed (safe direction) but operationally unbounded. Promotion requires an explicit claim-expiry or operator-release design. | ledger schema (no expiry column) |
| Manual recovery and reconciliation authority | Recovery is operator-driven through the SCQ store's recovery report plus ledger inspection; there is no automated cross-ledger reconciler and no defined authority model for releasing an orphan claim. For experimental use this is acceptable *because* the safe failure mode is blocking, not executing. | coordinator `recoveryReport()`; absence of a release path in bridge source |

## Verdict

The bridge **remains experimental**. Its safety rules are not
weakened to make promotion easier: the two promotion blockers are
(1) cross-ledger crash atomicity (or an explicitly designed
compensation protocol), and (2) orphan-claim lifecycle (expiry or
operator release with an authority model). Both are design work for
a future, separately governed proposal — not defects to patch
quietly in a hardening pass.
