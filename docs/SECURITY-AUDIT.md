# Security and Supply-Chain Audit — SCQ

**Date:** 2026-11-05 · **Scope:** repository at `fff2f4c` and the
published `@agorail-labs/scq-reference@0.6.2-experimental.1`
artifact. Part of the Stable Release Engineering Program, Phase 4.
Method: `npm audit`, tracked-file credential scan, workflow review,
published-tarball content inspection, adversarial test results.

## Findings

| ID | Finding | Severity | Disposition |
|---|---|---|---|
| S-SCQ-1 | Four workflows carried no `permissions:` block (`ci`, `agorail-integration`, `protocol-freeze-guard`, `provider-neutrality-check`) — the default token is broader than any of them need. | Low | **Fixed in this PR:** `contents: read` for CI/integration/neutrality; the freeze guard gets `contents: read` + `pull-requests: read` (it reads PR labels via `gh`). `attest-experimental-tarballs.yml` already declared `contents: read` and is otherwise **intentionally unchanged** — it reproduces the historical published bytes (pinned source commits, Node 20/22) and altering it would invalidate the attestation. |
| S-SCQ-2 | Checksum provenance caveat: local `npm pack` tarballs do not reproduce the published SHA-256 pins; cause **unexplained** (blocker B-SCQ-3). | Moderate (process) | **Controlled, not hidden:** the only trusted artifact route is the CI-attested one; the prepared `release.yml` builds from an identified commit, records the SHA-256 from the workflow's own output, smoke-installs the exact tarball, and publishes those exact bytes. No local pack is ever a release input. Root-cause work remains open under B-SCQ-3. |
| S-SCQ-3 | No Dependabot configuration. | Low | **Fixed in this PR** (`.github/dependabot.yml`: npm `/reference` + github-actions, weekly). Alerts themselves are enabled by a repo admin (checklist). |
| S-SCQ-4 | `SECURITY.md` exists and is substantively good (private reporting, scope, envelope-is-not-authorization warning). It predates the stable program and names v0.6.1 in its opening line. | Info | Left unchanged in this PR; the Phase 6 documentation PR refreshes it alongside the maintenance policy. |
| S-SCQ-5 | **The published package's optional dependency `better-sqlite3@^11.10.0` cannot be installed on Node 26**: no prebuild exists for its ABI and the source build fails against Node 26's V8 (removed `v8::Object::GetPrototype`, `v8::Context::GetIsolate`, `PropertyCallbackInfo::This`). npm drops the optional dependency silently; the durable store then fails closed with `DurableStoreError` — safe, but the durable path is unusable on Node 26 with the published artifact. (Node 22 and Node 24 consumers verified working; an early warm-cache matrix run that appeared to pass on Node 26 was not reproducible from a clean install and is not counted.) | High for the Node 26 support claim | **Fixed in this PR:** optional dependency bumped to `better-sqlite3@^13.0.3` (declares `engines: node >=22`, ships N-API prebuilds). Clean-install suite results with the fix: **915/915 on Node 22, 24, and 26**, plus a clean consumer run of the unified example on Node 26 (exit 0). The *published* experimental artifact remains Node 22/24-only for durable use until a future release ships the fix — stated plainly in the support documentation. |

## Verified clean / posture

- **`npm audit` (reference): 0 vulnerabilities.** Runtime surface
  is one *optional* dependency, `better-sqlite3`; if it cannot
  load, the durable store throws `DurableStoreError` — there is no
  silent in-memory fallback (pinned by Phase 3 tests).
- **Credential scan:** no credential-shaped strings in tracked
  files. No Chargebee (or any provider) credentials exist in the
  repository or its history of configuration; live dispatch remains
  prohibited and the live pilot is excluded from the tarball.
- **Published tarball (37 files):** verified to contain **no**
  `dist/src/live/`, no `dist/src/integration/`, no bridge code, no
  scripts, no `.env`/`.npmrc`. The same exclusion check is encoded
  in both the attestation workflow and the prepared release
  workflow.
- **Untrusted-input boundaries:** envelope handling uses a closed
  field set with own-property reads and a null-prototype sanitized
  envelope (spec §6.16 lineage); persistence corruption fails
  closed (Phase 3); INDETERMINATE resolution requires trusted,
  fresh, operation-bound evidence (test58/test59 lineage).
- **DoS surface:** the library performs no network I/O and parses
  no untrusted documents beyond caller-supplied records; SQLite
  file handling is confined to the caller-chosen path. No
  oversized-input finding was identified; pathological-envelope
  fuzzing remains a reasonable future addition, recorded honestly
  as not-yet-done rather than claimed.

## Administrator checklist (requires repo/org admin; not done here)

1. Enable **private vulnerability reporting** and **Dependabot
   alerts/security updates** (Settings → Security).
2. Confirm **branch protection** on `main`: required checks (CI
   matrix, freeze guard, provider neutrality), no force pushes.
3. Configure the **npm trusted publisher** for the prepared
   `release.yml` before any future publish.
4. Maintainer accounts: hardware-key 2FA (npm writes already
   require the account's security key).

## OpenSSF Best Practices — self-assessment (not a certification)

| Criterion area | State |
|---|---|
| Description, license, contribution guidance | Satisfied |
| Version control, public repo, issue tracking | Satisfied |
| Build + automated tests in CI | Satisfied (matrix 22/24/26 after this PR) |
| Vulnerability reporting process | Satisfied (SECURITY.md; admin step 1 completes it) |
| Dependency vulnerability scanning | Partial — audit clean; Dependabot config added, alerts are admin step 1 |
| Signed releases / provenance | Partial — published experimental artifacts are CI-attested with recorded SHA-256 pins; OIDC provenance arrives with the prepared release workflow's first use |
| Credentials in repo | Satisfied (none) |

No badge or certification is claimed.
