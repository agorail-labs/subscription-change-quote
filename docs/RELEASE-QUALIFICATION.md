# Release Qualification — SCQ 1.0.0-rc.1 (candidate)

**Candidate:** `@agorail-labs/scq-reference@1.0.0-rc.1` — PREPARED,
NOT PUBLISHED. **Base commit:** `fff2f4c` (main) plus this program's
PRs 1–5. **Specification:** remains v0.6.2 — a package candidate
does not re-version the spec. **Date:** 2026-11-05/06. Each gate
names its own evidence; nothing is inferred from unrelated
historical results. One earlier matrix reading (Node 26, warm
install state) proved **not reproducible from a clean install** and
was discarded — the Node 26 evidence below is the clean-install
re-run.

## Gate table

| Gate | Status | Evidence |
|---|---|---|
| Stable API defined | PASS | `docs/STABLE-RELEASE-READINESS.md` §2; exclusions §2.3; trust limitations §2.4 |
| Compatibility verified | PASS | Export surface identical to published (22 values, 69 types; extraction 2026-11-05); content deltas enumerated in `docs/API-INVENTORY.md` §3; alias behavior regression-tested (test65); `docs/MIGRATION-GUIDE.md` |
| Security review | PASS (internal) | `docs/SECURITY-AUDIT.md`: 0 audit vulnerabilities, credential scan clean, tarball free of live/integration code, workflow permissions least-privilege. Independent security review counts under Independent review |
| Failure recovery verified | PASS | Durable recovery lineage (test27–30, test63–64) plus Phase 3 `test70`: cross-process fence race (exactly one dispatch), corruption fail-closed, in-process concurrency; bridge crash posture in `docs/BRIDGE-EXPERIMENTAL-AUDIT.md` (bridge itself excluded from scope) |
| Maintained Node LTS support | PASS (candidate) | Clean-install suite with the `better-sqlite3@^13` fix: 915/915 on Node 22.14.0, 24.22.x, 26.13.0. **Published artifact caveat:** with `better-sqlite3@^11` the durable store cannot install on Node 26 — fixed only in this candidate (finding S-SCQ-5) |
| Clean-room install | PASS | Unified example green from clean installs: published packages on Node 22/24; candidate pack on Node 26 (exit 0, all lifecycle beats, 2026-11-06) |
| Supply-chain integrity | **PENDING** | Control exists (CI-attested route; prepared OIDC `release.yml` publishes only workflow-built, hash-recorded bytes), but the local-pack checksum discrepancy (B-SCQ-3) is **unexplained**. This gate passes only when the RC artifact has been produced and hash-verified through the release workflow — which requires maintainer authorization to run it |
| Operational documentation | PASS | `docs/API-REFERENCE.md`, `VERSIONING-POLICY.md`, `MIGRATION-GUIDE.md`, `SUPPORT.md`, `IDEMPOTENCY-AND-RECONCILIATION.md`, `RECOVERY-RUNBOOK.md`, refreshed `SECURITY.md` |
| Independent review | **PENDING** | Package prepared (`docs/STABLE-CANDIDATE-REVIEW.md`); nobody contacted (not authorized); zero substantive evaluations |
| Maintainer approval | **PENDING** | Awaiting the maintainer: stable-scope approval, the §6.16 governance decision (B-SCQ-2 — the candidate is scoped to the v0.6.2 spec as-is, so this gates 1.0.0, not the RC), and any release authorization |

## Known limitations carried into the candidate

- G-01: the core trusts adapter-established classification; it
  does not authenticate provider events.
- Conformance PARTIALs V62-DET-08, V62-EVD-01, V62-SV-02, as
  scoped in the v0.6.2 audit.
- Simulators are test doubles; no live dispatch is supported.

## Recommendation

**GO for 1.0.0-rc.1 as a review candidate**, produced exclusively
through the prepared CI release workflow on the maintainer's
separate authorization. **NO-GO for 1.0.0 stable** until
Supply-chain integrity (RC produced + hash-verified via the
workflow), Independent review (≥2 substantive evaluations, one
adversarial), and Maintainer approval (including the §6.16
decision) all close. Until then every public claim stays
experimental.
