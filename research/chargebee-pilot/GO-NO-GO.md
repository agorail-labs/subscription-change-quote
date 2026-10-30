# Chargebee pilot — go/no-go report

Date: 2026-10-28. Scope: issue #12 pilot readiness. Evidence:
EVIDENCE-REPORT.md (this folder); classifications there govern.

## Decision 1 — Pilot ready for independent technical review: **GO**

Justification, from evidence rather than assertion:

- The workflow is **executable and reproducible**: one documented
  command (`npm run pilot:chargebee`) runs retrieve → snapshot →
  proposal → quote → comparison → report with no credentials and no
  network, producing structured JSON + Markdown evidence
  (VALIDATION-CHECKLIST.md gives the exact expected values).
- The comparison is **falsifiable**: test 21-p3 proves the
  field-by-field comparison fails against a divergent raw estimate —
  it is a check, not a rubber stamp. After the PR #13 review
  correction (EVIDENCE-REPORT.md §C), interpretation correctness
  itself is verified independently of the adapter by a test-only
  oracle (tests 22-o1/o2): the harness comparison is a consistency
  check, and the oracle — which imports no adapter code — is what
  verifies values and provenance against the raw response.
- Financial semantics are **verified at the boundaries the design
  cares about**: unknown refuses instead of becoming zero (21-n1/n2),
  a stated zero is preserved (21-z1), partial stated lists are never
  summed (21-n3), unsupported pricing models refuse (21-n4), credits
  and amount_due never enter the incurred/recurring figures (21-p4),
  and every determined figure carries field-level provenance
  (PROVENANCE-MATRIX.md).
- Safety behavior is **demonstrated, not described**: commit gate
  (21-c1), stale/expired refusals with zero mutating calls (21-c2/c3),
  lost-response discipline (21-c6), and refusal to issue a verified
  receipt on silently-wrong landed state (21-c7/c9).
- The full suite is green from a clean build (**261/261** after the
  PR #13 corrections and re-review corrections; 247/247 at delivery),
  the package smoke passes,
  and the diff touches no frozen file.

## Decision 2 — Controlled test-site commit: **NO-GO** (not ready to propose yet)

Blocking conditions, all from COMMIT-RECOVERY-SAFETY.md §8:

1. **v0.6.2 Chargebee migration incomplete** — the live adapter still
   runs frozen v0.6.1 semantics; in particular the receipt type cannot
   represent "committed but financially unverified" (Defect 3), so the
   adapter's only honest posture on undeterminable actuals is
   INDETERMINATE with no receipt.
2. **No durable quote/receipt store** — the in-memory store cannot
   prove §6.10 replay after restart; a live commit without the §3
   durable ledger + write-ahead intent record is not safe to authorize.
3. **No executed preflight for a specific commit** — tenant/resource/
   action, scheduled-change state, and the anticipated billable effect
   have not been stated for any concrete proposed commit.
4. **No named reconciliation owner** and no rehearsed live §5 run.
5. **No separate authorization** — issue #12 explicitly does not grant
   one; `SCQ_LIVE_COMMIT_ENABLED` stays false.

The PR #13 live-read safeguards (preflight contract + transport
allowlist, tests 22-g1/g2) harden the read path; they do not change
this decision — condition 3 concerns an executed preflight for a
specific COMMIT, which has not been run.

The re-review corrections (EVIDENCE-REPORT.md §D) likewise do not
change this decision: F1 makes the read-path preflight an explicit
per-run approval check (configuration/approval validation, not
provider attestation) and F2 confines LIVE_PASS to the real network
path, so stubbed runs can no longer be mislabeled as live evidence.
Both strengthen the evidence for Decision 1; neither is a step
toward authorizing a commit, and the commit NO-GO above is
unaffected.

A controlled test-site commit **can be proposed** for separate
authorization once conditions 1–4 are satisfied and evidenced; the
proposal must name the exact tenant, resource, action, and billable
effect, per §2/§8 of the safety design.

## Decision 3 — Live read/estimate re-validation in this run: **BLOCKED** (not a failure)

No credentials were present in the pilot environment (variable names
checked; values never sought). The harness's live mode therefore made
no network call and classified live retrieve/quote BLOCKED with the
exact requirement (Full-Access test-site key + synthetic subscription
id, via env). The Oct 27, 2026 LIVE_PASS evidence stands as historical
(EVIDENCE-REPORT.md §B) and is not re-claimed.

---

## Addendum (2026-10-29, PR-11) — preflight and rehearsal delivered; Decision 2 unchanged: **NO-GO**

PR-11 adds the machinery conditions 2 and 3 call for, without
changing any decision above:

- **Condition 2 evidence strengthened (SIMULATED).** The mocked
  recovery rehearsal (`src/live/pilot/rehearsal.ts`, 14 scenarios)
  drives the real durable store, coordinator, and adapter over
  mocked transports: successful dispatch + durable recording, exact
  receipt replay after restart, lost response, crash after
  write-ahead intent, crash after dispatch before persistence,
  wrong resulting item set, unexpected mandatory addon (recorded as
  reconciliation VIOLATED on the attributable receipt), unknown
  financial actuals (COMMITTED_UNVERIFIED), established envelope
  violation, concurrent same-subscription attempts, idempotency-key
  conflict, corrupted durable records, operator review of an
  unresolved attempt, and pre-effect rejection
  (CONFIRMED_NON_EXECUTION). 14/14 pass; the evidence class is
  SIMULATED_PASS — procedural readiness only. It does not prove
  durable exactly-once provider execution and does not name or bind
  an operator.
- **Condition 3 machinery delivered; condition itself still
  UNVERIFIED for any real commit.** The read-only exact-commit
  preflight (`src/live/pilot/preflight.ts`, CLI
  `npm run preflight:chargebee`) derives the hypothetical mutation
  with the adapter's own request builder, hashes it with the
  ledger's canonical request hash, re-reads provider state through
  the existing guarded allowlist (zero observed mutations, from the
  transport log), and reports the four financial quantities
  separately with provenance. A sample mocked run is committed at
  `runs/preflight-mocked-2026-10-29/` (overall NO-GO). No preflight
  against a real tenant has been executed — no credentials were
  present, consistent with Decision 3 — so condition 3 has no
  real-commit evidence.
- **Conditions 1, 4, 5 unchanged.** No v0.6.2 release approval has
  been recorded (merged PRs are not release approval); the operator
  runbook (`OPERATOR-RECONCILIATION-RUNBOOK.md`) is a blank template
  — no reconciliation owner is named; no commit authorization has
  been granted. The preflight's readiness model can return at most
  READY_FOR_HUMAN_REVIEW and, on current evidence, returns NO-GO.

**Decision 2 stands: NO-GO for any controlled test-site commit.**
