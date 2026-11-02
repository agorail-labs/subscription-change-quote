# SCQ Package Release Readiness — @agorail-labs/scq-reference

**Status of this document:** release-readiness and release-configuration
assessment for the first experimental npm package candidate (Issue #31).
This release-configuration PR removes the prior `private: true` npm
publication guard **only in a review-gated branch**; the package remains
unpublished. This document and PR do **not** authorize registry
publication, creating tags/releases, or enabling live billing. Final
artifact approval and a separate manual npm publish are required.

Prepared against main `f7e9360` (PR #52 merged). All results below
were measured on the branch `package/agorail-experimental-readiness`;
commands and outputs are reproducible from the PR head (section 10).

**Update (maintainer-review correction):** the branch has since
merged main `e4df68f` (PR #54, the consolidated conformance audit),
and the shipped documentation now carries the audit's conformance
disclosures (sections 10 and 11 record the audit's outcome). The
artifact was re-packed after the documentation correction; the
current checksum is in section 4.

## 1. Proposed package identity

| Field | Value |
| --- | --- |
| Name | `@agorail-labs/scq-reference` |
| Version | `0.6.2-experimental.1` |
| License | Apache-2.0 |
| Engines | Node >= 20 |
| Type | ESM only (`"type": "module"`, exports map: `.` → import + types) |

**Version rationale.** The `0.6.2` core tracks the published spec
version this package implements, so a consumer can tell at a glance
which protocol a build speaks. The `-experimental.1` prerelease
suffix marks non-production status and sorts below any future stable
`0.6.2`, so an experimental line can never be mistaken for — or
auto-upgraded into — a stability promise. (The previous identity,
`@arjun2075/scq-reference` version `0.1.0` describing "SCQ v0.6.1",
was stale on all three axes: scope, versioning, and spec version.)

## 2. npm scope status

- `GET registry.npmjs.org/@agorail-labs%2fscq-reference` → **404**: the
  package name is **not registered** (verified 2026-11-01). The old
  `@arjun2075/scq-reference` name is likewise unregistered.
- **Scope ownership — resolved after the original readiness assessment.**
  On November 1, 2026, the maintainer reported authenticated-session
  evidence that npm user `agorail` created the npm organization
  `agorail-labs` on its free public-package plan and is its sole
  owner. Ownership evidence is from the signed-in npm settings pages;
  unauthenticated access is bot-blocked. The maintainer also confirmed
  **account 2FA enabled**. Do not record secrets or recovery codes.
  Publishing rights must still be checked with the authenticated npm
  CLI at release time; no registry publication has occurred.

## 3. Phase 1 audit findings

**Exports/main/types.** `main`, `types`, and the `exports` map all
resolve to `dist/src/index.js` / `dist/src/index.d.ts`, verified by
importing the installed tarball **by package name** from a separate
consumer project on both toolchains (no relative paths, no tsconfig
aliases). The exports map exposes only `.` — deep imports are
encapsulated.

**Public API surface (22 runtime exports).** `SCQError`; the four
simulator adapters and simulators (`StripeAdapter`/`StripeSim`,
`PaddleAdapter`/`PaddleSim`, `ZuoraAdapter`/`ZuoraSim`,
`ChargebeeAdapter`/`ChargebeeSim`); `QuoteStore`; the durable layer
(`DurableQuoteStore`, `DurableMutationCoordinator`,
`createProviderEvidenceVerifier`, `establishVerification`,
`verifyPostCommitState`, `evidenceEntryId`, `observedStateDigestOf`,
and the durable error types + `RESOLUTION_EVIDENCE_MAX_AGE_MS`); plus
~57 exported types from `core/types.ts` and the store modules.
**Correction made:** the simulators' subscription seed types
(`StripeSubscription`, `ChargebeeSubscription`, etc., with component
types) were not reachable from the package root — TS consumers could
only type fixtures structurally. They are now exported as types
(type-only change; runtime surface unchanged; suite unchanged).

**Stability judgement.** The surface is appropriate for *experimental*
use: the protocol types are additive-versioned per v0.6.2, but no API
stability promise is made or implied, and the version scheme reserves
the right to change the surface with the spec during the experimental
line.

**Live-provider exposure.** The public entry point exports **no**
live-provider code: `ChargebeeLiveAdapter` and the pilot harness are
not reachable from `index.ts`. Two honest qualifications:

1. *Before this branch*, the tarball nevertheless **physically
   contained** `dist/src/live/**` — 22 of 55 files, including the
   env-gated pilot runner — because `files` allowlisted all of
   `dist/src/`. Encapsulation blocked importing it, but shipping
   live-mutation tooling inside a "simulator-only" artifact is the
   wrong default. **Corrected:** `files` now excludes
   `dist/src/live/`; the artifact contains no live code at all.
2. The manifest's repo-only scripts (`pilot:chargebee`,
   `preflight:chargebee`) remain in `package.json` because the same
   manifest serves the repository checkout, where the live research
   tooling legitimately lives. In an installed copy those scripts
   point at files that are not present and fail immediately; they
   grant no capability. Recorded here as a known cosmetic item for
   the maintainer's publication decision, not silently removed,
   because removing them would break the repository's own pilot
   workflow entry points.

What an importer **can** do: run the four simulators, quote/commit
against them, use both stores, and implement `SubscriptionProvider`.
What an importer **cannot** do with this artifact: reach any real
provider. The live adapter's own gates (OPERATION-scope
authorization-preservation refusal; `SCQ_LIVE_COMMIT_ENABLED`)
remain repository-side facts and are unchanged.

**Dependencies.** Runtime: only the optional `better-sqlite3`
(native, SQLite). Development-only: `typescript`, `@types/node`,
`@types/better-sqlite3` — none ship. **Native behavior:** the durable
store loads `better-sqlite3` lazily via `createRequire`, only when a
`DurableQuoteStore` is constructed. Verified in a consumer installed
with `--ignore-scripts` (no binding): in-memory scenarios run
normally, and durable construction fails with an explicit
"Durable store unavailable: … bindings file" message — no silent
degradation, no fallback invented. With a normal install, the
toolchain-matching binding installs and the durable path works on
both Node 20 and Node 22 (section 5).

## 4. Tarball (from the PR head)

- Filename: `agorail-labs-scq-reference-0.6.2-experimental.1.tgz`
- **sha256: `501ddbd72ed3cc206f227ff5621ae5ad58224bffecca55696233942e1a5d0f04`**
  — identical across independent `npm pack` runs on Node 22 and
  Node 20 from the corrected head, i.e. the artifact is
  reproducible from the head. Size: 296,433 bytes. **37 files**.
  (This checksum supersedes `a9b60305…` from the original readiness
  head: the artifact changed because the shipped `README.md` and
  `DEVELOPER-GUIDE.md` gained the conformance disclosures —
  the file count is unchanged and no code changed.) Contents:
  28 built JS/declaration files under `dist/src/` (adapters, core,
  store, index — no `live/`), `examples/` (3 scenarios), `README.md`,
  `DEVELOPER-GUIDE.md`, `LICENSE`, `package.json`.
- Reproducibility mechanism: a `prepack` script runs the existing
  TypeScript build, so `npm pack` from a clean tree (no `dist/`)
  produces the complete artifact — verified by deleting `dist/`
  before packing in every clean-room run.

## 5. Clean-room validation (Phase 5) — measured

Procedure per toolchain, in a disposable consumer project outside
the repository: fresh `npm ci` in `reference/` → delete `dist/` →
`npm pack` → `npm install <tarball>` (default scripts) → ESM import
and export enumeration → `tsc --strict` typecheck of a consumer file
using the public API types (typescript installed only in the
disposable project) → compile and run that consumer → run the three
shipped examples **from the installed copy** → confirm the
`better-sqlite3` binding and the durable SQLite flow (inside
scenario C, part 2).

| Check | Node 20.19.5 | Node 22.14.0 |
| --- | --- | --- |
| Tarball installs, deps resolve (39 packages incl. optional native) | PASS | PASS |
| `better_sqlite3.node` binding present & loads | PASS | PASS |
| ESM import by name; 22 runtime exports enumerated | PASS | PASS |
| TypeScript declarations typecheck a typed consumer | PASS | PASS |
| Typed consumer runs: COMMITTED_AND_VERIFIED / OK | PASS | PASS |
| Scenario A (verified commit) | PASS | PASS |
| Scenario B (VIOLATED + UNVERIFIED) | PASS | PASS |
| Scenario C (INDETERMINATE + durable replay after restart) | PASS | PASS |
| Artifact-only (no repo node_modules / aliases / checkout) | PASS | PASS |

Scenario outputs (identical semantics on both toolchains): A —
quote immediate 20000 / recurring 120000, both DETERMINED, receipt
COMMITTED_AND_VERIFIED / OK. B part 1 — landed quantity 130 vs
authorized 120: DETERMINED + VIOLATED. B part 2 — third-party
addition in the validate→dispatch window: recorded 12500 as a
candidate, UNKNOWN determinacy, `unestablished` source,
COMMITTED_UNVERIFIED / UNVERIFIED. C part 1 — lost response:
INDETERMINATE, outcome recorded on the quote, retry refused with
dispatch count still 1, independent observation shows the landed
quantity 120. C part 2 — durable commit, restart, re-commit replays
the original receipt with no second dispatch.

Repository-side automation: `npm run smoke:pack` (extended on this
branch) performs the offline variant — pack, install with
`--ignore-scripts`, ESM + TS checks, and scenarios A/B from the
installed copy — and passes on both toolchains.

## 6. Repository suites at the PR head

| Suite | Baseline (main `f7e9360`) | This branch |
| --- | --- | --- |
| Full suite, Node 20 | 863/863 | **863/863** |
| Full suite, Node 22 | 863/863 | **863/863** |
| Research repro suite | 11 pass / 7 fail | **11 pass / 7 fail** (unchanged, by design) |

**Correction revalidation.** After merging main `e4df68f` (PR #54 —
docs/research-only; the suite baseline is unchanged) and the
shipped-documentation correction, the full suite, research suite,
and `npm run smoke:pack` were re-run on the corrected head with a
fresh per-toolchain `npm ci`: **863/863 on Node 20.19.5 and on
Node 22.14.0**, research suite **11 pass / 7 fail** on both, and
smoke:pack **PASS** on both. The artifact was then re-packed from
a clean tree (section 4).

Spec integrity: `spec/scq-v0.6.2-spec.md` sha256 `4100d249…`,
`spec/scq-v0.6.1-spec.md` sha256 `0d32e584…` — both identical to
main. Zero changes to spec files, core engine/types, adapters,
stores, or any conformance/research files. Behavior changes: **none**
(the only `src/` edits are a stale version word in the `index.ts`
header comment — v0.6.1 → v0.6.2 — and type-only export additions).

## 7. Security and release audit (Phase 6) — measured on the tarball

- Full 37-file list enumerated; **no** credentials, API keys, tokens,
  private keys, test-site identifiers, `.env` files, SQLite
  databases, logs, fixtures, or build caches (pattern greps over the
  extracted artifact: clean). The one grep hit for pilot strings is
  the manifest's repo-only script *names* (section 3, item 2).
- **No `publishConfig`** in the manifest; `private: true` present;
  **no** workflow in `.github/workflows/` publishes anything (CI
  only installs, tests, and runs demos).
- No live code in the artifact (section 3); no example exercises a
  live path; every real-provider reference in the shipped docs is
  explicitly marked unavailable/disabled.
- No claim of certified provider conformance anywhere in the shipped
  files; the docs state the opposite.

## 8. Experimental limitations (summary; full text in the shipped guide)

Simulator-only semantics on modeled catalogs; BEST_EFFORT consistency,
no atomicity claim; the acceptance envelope is drift tolerance, not
authorization; determinacy rests on adapter-produced evidence (core
trust limitation, register G-01); candidates are response-sourced
only (§3.10); durability requires the durable store and does not
create exactly-once provider execution; INDETERMINATE resolution is a
manual, evidence-based operator act. Conformance (merged audit,
PR #54): 72 of 75 Appendix B rules IMPLEMENTED, 3 PARTIAL
(V62-DET-08, V62-EVD-01, V62-SV-02), 0 BLOCKED, on simulator-level
evidence — plus two disclosed fail-closed limitations, issue #45
(durable exclusion over-blocks identical subscription IDs across
provider/site boundaries) and issue #51 (a pre-v4 ASSERTED migrated
landing reconciliation cannot be superseded by a new VERIFIED
barrier); full text in the shipped README and in section 14 of the
developer guide.

## 9. Gated publication checklist — NOT executed

Maintainer decisions D-1..D-6 and the 2FA prerequisite are now accepted,
as recorded in Issue #31. They authorize preparation and review of a
release-configuration PR, **not** the registry publish action. Publishing
still requires the maintainer's separate explicit approval of the final
artifact and its verification record.

1. **Scope**: **DONE (maintainer-confirmed)** — npm organization
   `agorail-labs` exists; npm user `agorail` owns it and has enabled
   account 2FA. Confirm current authenticated CLI identity and
   publishing rights immediately before manual publication.
2. **Conformance and governance**: **DONE** — the consolidated audit
   PR #54 was merged as `e4df68f` (72 IMPLEMENTED / 3 PARTIAL /
   0 BLOCKED; simulator evidence). The maintainer accepted decisions
   D-1..D-6, including **D-3 / Issue #51** and **D-4 / Issue #45**
   as disclosed **Class B** fail-closed limitations only for this
   simulator-only experimental package; neither issue is fixed.
   The ratified G-01 trust limitation is accepted for this release
   only; normative proposals remain deferred.
3. **Release configuration (THIS DRAFT PR; NOT MERGED):** remove
   `private: true` from `reference/package.json`, update shipped
   distribution documentation, and re-run `npm ci`, full suite and
   `npm run smoke:pack` on Node 20/22. Confirm the tarball contents
   include **no `dist/src/live/`**, record the complete SHA-256 and
   file count **from the final release commit**, and independently
   reproduce them before publish. The checksum will differ from
   the historical readiness artifact because metadata/docs changed.
4. **REQUIRES A SECOND, EXPLICIT PUBLICATION APPROVAL:** from an
   authenticated maintainer environment, verify `npm whoami`, inspect
   the exact final tarball and integrity checksum, and only then run
   `npm publish agorail-labs-scq-reference-0.6.2-experimental.1.tgz --access public --tag experimental`
   through npm's required interactive 2FA or a currently permitted
   secure authentication method. Never share OTPs, recovery codes,
   or tokens in GitHub comments or PRs. No CI publishing.
5. Verify the registry page, install the published package into a
   fresh project, and re-run the three scenarios from the registry
   artifact.
6. Announce as an experimental preview, linking the spec and this
   readiness document; keep the `experimental` dist-tag until a
   stable line is separately approved.

## 10. Conformance dependency (Phase 7) — audit delivered and merged

This branch modifies **no** conformance traceability, gap-register,
or research files. The dependency recorded as pending in the
original readiness pass is no longer pending: Agent 1's
consolidated conformance audit under issue #29 was delivered as
PR #54 and **merged into `main` as `e4df68f`**, and this branch has
merged that main. Full record: `research/v0.6.2-conformance-audit.md`;
decisions and the npm recommendation are in section G of
`research/v0.6.2-release-readiness.md`, which is the normative
source for the conformance disclosures now carried in the shipped
`README.md` and `DEVELOPER-GUIDE.md`.

**Audit result.** The full 75-rule matrix (spec Appendix B) was
re-verified — no status changes: **72 IMPLEMENTED / 3 PARTIAL /
0 BLOCKED**, from simulator-level evidence (full suite 863/863 on
Node 20 and 22 at the audited head; research suite 11 pass / 7 fail,
all guard-blocked by design). The three PARTIAL rows are
**V62-DET-08** (snapshot determinacy is descriptive — no enforcement
consumer of the field), **V62-EVD-01** (G-01 — provider-origin
authenticity not demonstrated; the core trusts adapter-established
classification and does not independently authenticate provider
events), and **V62-SV-02** (G-08 narrowed — the shared hook is
consumed by the store, Chargebee-live, Chargebee-sim UPDATE, and
Stripe EXACT/CANCEL; Chargebee-sim CANCEL, Paddle CANCEL, and Zuora
remain adapter-owned specializations). The audit classified **no
class-A (release-blocking) items** for a simulator-only package;
issues #45 and #51 are class B, and its NO-GO stands for any live or
test-site commit, any production use, and any unqualified
conformance claim.

**Audit recommendation: CONDITIONAL GO** — for a simulator-only
experimental npm package only — on these exact conditions (§G):

1. Release notes and the package README carry the three PARTIAL
   rows and the Issue #45 / #51 limitations in substance, and make
   no unqualified conformance or provider-authentication claim.
   *(Status: satisfied by this PR's documentation correction — the
   shipped README and developer guide carry all three PARTIAL rows
   and both limitations, and disclaim any blanket conformance
   claim.)*
2. The release-candidate PR (D-6) re-runs, on its exact head:
   `npm ci`, build, the full suite, and `npm run smoke:pack`, on
   Node 20 and Node 22 — the audit's 863/863 + smoke-pack pass at
   `f7e9360` is baseline evidence, not a substitute. *(Status:
   satisfied for this PR's corrected head — the re-run results are
   recorded in sections 5 and 6.)*
3. The package ships with no live commit path enabled; the live
   adapter remains experimental and preservation-refusing, and the
   package text says so. *(Status: satisfied — the re-packed
   artifact contains no live code (section 4) and the shipped text
   states the live adapter's status.)*
4. D-3 and D-4 are either resolved or explicitly accepted as
   class B in the release record by the maintainer. *(Status:
   SATISFIED — maintainer accepted both issues as Class B for
   simulator-only experimental release preparation; neither fixed.
   Recorded on Issue #31.)*

**Decisions D-1..D-6: accepted by the maintainer.** D-1 retains
V62-DET-08 PARTIAL; D-2 accepts the trusted-adapter boundary only
for this experimental release; D-3 and D-4 accept Issues #51 and #45
as Class B disclosed fail-closed limitations, not fixes; D-5 defers
the §6.16 normative amendment; D-6 approves preparing this separate
release-configuration PR. The decision record is Issue #31. **The
actual npm publication still requires its own explicit approval.**

Package smoke tests and clean-room installs remain what they always
were: evidence that the artifact installs and behaves as its own
suites specify. They are **not** conformance evidence, and nothing
in the shipped documentation claims IMPLEMENTED conformance on
their basis.

## 11. Recommendation

**CONDITIONAL GO** for npm publication.

The artifact itself is ready: metadata corrected, live code excluded,
documentation and runnable examples shipped, clean-room installation
and all three scenarios verified on Node 20 and Node 22, suites
unchanged at 863/863, artifact reproducible (single sha256 across
toolchains), and the security audit clean. The external prerequisites (npm ownership, owner-confirmed 2FA and
D-1..D-6 governance acceptance) are now satisfied for **preparing**
the release configuration. The remaining hard gates are: (1)
review/merge of this release-only PR after exact-head Node 20/22,
neutrality and freeze checks, smoke-pack, and final-artifact hash and
contents audit; (2) re-verify npm CLI scope rights; and (3) a
**separate explicit approval of registry publication** before any
manual publish. Readiness is not authorization.

## 12. Post-governance release-configuration handoff (November 1, 2026)

This section supersedes earlier pending/UNKNOWN labels in this document:

- npm org ownership was confirmed by the maintainer in authenticated npm
  settings; account 2FA was subsequently reported **enabled**. No npm
  credential or authenticator secret is stored in this repository.
- Maintainer **accepted D-1..D-6**. V62-DET-08 and the other two PARTIAL
  rows remain PARTIAL. The G-01 adapter-trust boundary is an explicit
  experimental-only limitation. Issues #45 and #51 are **Class B for
  simulator-only evaluation**, still open and still fail-closed.
  The §6.16 amendment remains separately governed and deferred.
- The current PR changes **only distribution metadata, package-smoke
  audit logging, and release-facing documentation**. The smoke script
  prints the candidate tarball's SHA-256, bytes and file count in CI;
  it does not publish or change runtime behavior. Removing `private:
  true` permits a *future* npm registry submission, not one now. Neither a CI publishing
  job nor a tag/release is added. Simulator-only exports and the
  `!dist/src/live/` packaging exclusion remain intact.
- At the PR's final exact head, record CI results, tarball SHA-256,
  file count, and absence of live files. A tarball built before these
  changes, including the former readiness checksum, is **not** the
  authorized candidate. The final hash must be independently
  reproducible.
- **STOP before registry publication.** The maintainer must separately
  approve the exact final artifact and the manual npm publication
  command. Then verify the published registry artifact and its
  simulator examples in a fresh environment. Issue #31 remains open
  until the registry release is verified.
