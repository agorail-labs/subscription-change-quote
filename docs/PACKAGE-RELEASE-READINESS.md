# SCQ Package Release Readiness — @agorail-labs/scq-reference

**Status of this document:** release-*readiness* assessment for the
first experimental npm package candidate (issue #31, package half).
It is **not** publication authorization. The package remains
`private: true`, unpublished, and unpublishable from this branch
without the separate gated steps in section 9.

Prepared against main `f7e9360` (PR #52 merged). All results below
were measured on the branch `package/agorail-experimental-readiness`;
commands and outputs are reproducible from the PR head (section 10).

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
- **Scope ownership and publish permissions: UNKNOWN.** There are no
  npm credentials in the build environment, so whether the
  `@agorail-labs` npm organization exists, who controls it, and who
  may publish under it **cannot be verified from here**. "Not
  registered" must not be read as "available to us": a maintainer
  must create or confirm the npm organization and grant publish
  rights before any release step (section 9, step 1). This is a
  publication blocker, not a package defect.

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
- **sha256: `a9b603053f76c57f213d4fbdfcbb2e69dc39a5842dd26ba506d21715d334e4dc`**
  — identical across three independent `npm pack` runs (Node 22,
  Node 20, and a repeat Node 22 pack), i.e. the artifact is
  reproducible from the head. Size: 294,521 bytes. **37 files**:
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
manual, evidence-based operator act.

## 9. Gated publication checklist — NOT executed

Each step requires the maintainer's explicit approval at the time it
is taken; nothing here pre-authorizes any of them.

1. **Scope**: create or confirm the `@agorail-labs` npm organization;
   confirm ownership; enable organization 2FA; grant the publishing
   account access. *(Blocker until done — currently UNKNOWN.)*
2. **Conformance dependency**: obtain Agent 1's final issue-#29
   conformance recommendation (section 10). *(Pending.)*
3. In a **separate, approved change**: remove `private: true` from
   `reference/package.json` (and only that), re-run the full suites
   and `npm run smoke:pack`, re-pack, and confirm the tarball sha256
   is unchanged apart from the manifest.
4. `npm publish agorail-labs-scq-reference-0.6.2-experimental.1.tgz --access public --tag experimental`
   from the verified artifact of step 3, using a granular access
   token with publish rights to the scope, from a maintainer's
   environment (no CI publishing).
5. Verify the registry page, install the published package into a
   fresh project, and re-run the three scenarios from the registry
   artifact.
6. Announce as an experimental preview, linking the spec and this
   readiness document; keep the `experimental` dist-tag until a
   stable line is separately approved.

## 10. Conformance dependency (Phase 7)

Agent 1 is concurrently auditing conformance under issue #29. This
branch modifies **no** conformance traceability, gap-register, or
research files. **Explicit dependency: the conformance recommendation
from Agent 1's issue-#29 final audit is PENDING.** Package smoke
tests and clean-room installs demonstrate that the artifact installs
and behaves as its own suites specify; they are **not** conformance
evidence, and nothing in the shipped documentation claims IMPLEMENTED
conformance on their basis. If that audit identifies a genuine
release-blocking defect, it is to be recorded as a blocker here
rather than worked around in the package.

## 11. Recommendation

**CONDITIONAL GO** for npm publication.

The artifact itself is ready: metadata corrected, live code excluded,
documentation and runnable examples shipped, clean-room installation
and all three scenarios verified on Node 20 and Node 22, suites
unchanged at 863/863, artifact reproducible (single sha256 across
toolchains), and the security audit clean. The conditions are
external to the package, and each is a hard gate, not a formality:
(1) npm scope ownership/permissions are unverified and must be
established by a maintainer; (2) Agent 1's issue-#29 conformance
recommendation is still pending; (3) publication itself — including
the `private: true` removal — requires the maintainer's separate,
explicit approval under the checklist in section 9. Readiness is not
authorization.
