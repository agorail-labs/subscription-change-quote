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
