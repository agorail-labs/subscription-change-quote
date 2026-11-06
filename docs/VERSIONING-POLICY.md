# Compatibility and Versioning Policy (proposed for 1.0)

**Status: PROPOSED — takes effect only if and when a stable 1.0 is
approved.** The current published line is experimental
(`0.6.2-experimental.1`) and carries no compatibility promise.

## Four versions, kept distinct

| Version | Where it lives | Changes when |
|---|---|---|
| Package version | `reference/package.json`, npm | Per this policy |
| Specification version | `spec/scq-v*.md` | Only through the protocol governance process (freeze guard + `protocol-change-approved`) |
| Source line | git history / branch names (e.g. "v0.7 development line") | Continuously; has no consumer meaning |
| Documentation | this `docs/` tree | With the package it describes |

A package release never renames or re-versions the specification.

## Semantic versioning for the package (from 1.0)

- **MAJOR** — any breaking change to the stable core
  (`docs/STABLE-RELEASE-READINESS.md` §2): removing or renaming an
  export, narrowing a type, changing an error code, changing a
  documented behavioral guarantee, or raising the minimum Node
  version.
- **MINOR** — backward-compatible additions: new exports, new
  optional fields, new mutation-category coverage within the four
  supported categories' semantics.
- **PATCH** — bug fixes that restore documented behavior, security
  fixes, documentation.

## How compatibility is enforced

1. **API surface snapshot** (`docs/api/public-api.snapshot.json`,
   guarded by a drift test): any export-name change fails CI until
   the snapshot is regenerated in the same PR that justifies it.
2. **Behavioral regression suite**, including the Phase 3 hardening
   tests (property arithmetic, cross-process fencing, corruption
   fail-closed).
3. **Published-artifact compatibility checks** at release time: the
   release workflow installs the exact candidate tarball in a clean
   consumer and runs the unified example before publishing.

## Deprecation

A deprecated surface (e.g. the envelope spelling
`maxImmediateCreditDecrease`) remains functional for at least one
MAJOR line after its replacement ships, and its removal is called
out in the migration guide before it happens. Stored records are
never rewritten by a rename: aliases resolve at read/compare time.

## Experimental surfaces

Anything outside the stable core — the MSE–SCQ bridge, the live
pilot, research code — may change in any release, is labeled
experimental wherever it appears, and must not be reachable from
the stable core's exports.
