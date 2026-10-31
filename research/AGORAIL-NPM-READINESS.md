# Agorail SCQ npm packaging and adoption readiness — decision checklist

Status: **PREPARATION ONLY / NO-GO for publishing.** Workstream [#31](https://github.com/agorail-labs/subscription-change-quote/issues/31). The reference implementation is a simulator-backed experiment and no registry package is published.

## Exact existing package facts

`reference/package.json` currently declares:
- `name: "@arjun2075/scq-reference"`
- `version: "0.1.0"`
- `private: true`
- `type: "module"`, Node `>=20`
- `main: "./dist/src/index.js"`, `types: "./dist/src/index.d.ts"`, `exports["."]` for import/types
- `files: ["dist/src/", "README.md", "LICENSE"]`
- `npm run smoke:pack` for a local isolated-consumer smoke test

These settings describe an **unpublished** reference package and should stay unchanged in this PR. In particular, the current `@arjun2075` name does **not** mean an `@agorail-labs` npm scope exists or is owned.

## Distinct gated decisions

1. **Publish SCQ v0.6.2 experimental specification:** only by the separately approved publication transition under `research/v0.6.2-publication-decision.md` §4.1/§5. This does not authorize a package.
2. **Package scope and ownership:** project owner verifies actual npm.org organization ownership/access, selects a package name (candidate `@agorail-labs/scq-reference`), and establishes publishing permissions and provenance. Do **not** infer npm namespace ownership from the GitHub organization.
3. **Conformance posture:** for V62-DET-08, V62-EVD-01, V62-SV-02 and G-09, either close the gap with direct evidence or explicitly accept/label it as a documented limitation in any **experimental** package release notes. No blanket `v0.6.2-conformant` declaration on green CI alone.
4. **Release candidate:** on a separate PR update `name`, `version`, `private`, `description`, `reference/README.md` and public examples only after owner approval. Run `npm ci`, `npm run build`, `npm test`, `npm run smoke:pack`, Node20/22 CI and public-entrypoint import/type checks on the exact release head. Verify packed files and license, and prohibit bundled test credentials.
5. **Publication:** require a second explicit authorization to create a registry release. Use least-privilege publish credentials and release provenance; test that published archive and tag match the reviewed commit. No registry write from this planning document.
6. **Adopter feedback and distribution:** establish a versioned quick start, migration guide, typed examples for all four simulator-backed adapters, receipt interpretation and failure handling, issue template/support expectations, security-contact policy, and an evidence/limitations page.
7. **Provider pilots and production:** entirely separate gates. No npm or specification release authorizes real billing mutation. Pilot #12 remains NO-GO until exact tenant/commit controls, provider preservation and reconciliation owner are independently established.

## Acceptance checklist for a future *package-readiness* PR

- [ ] Experimental v0.6.2 spec publication complete under its own authorization
- [ ] Npm organization scope ownership and publisher credentials verified by owner
- [ ] Versioning and import/type shape documented, exports match the tarball
- [ ] `private: true` removal explicitly authorized in the package PR
- [ ] Simulator-only quote/commit examples with no provider secrets
- [ ] Distinct external absolute-budget and authorization checks documented
- [ ] UNKNOWN versus zero, candidate versus actual, and receipt replay/verified views demonstrated
- [ ] Conformance limitations accurately preserved and traceability current
- [ ] Fresh Node20/22 and smoke-pack pass on exact package-release commit
- [ ] Security/provenance review, changelog and maintainer support policy
- [ ] Separate registry-release authorization, tag, and artifact verification

**Non-goals:** no production billing SDK, no claims of provider endorsement, no real Chargebee commit, no bare `v0.6.2` package/spec conflation. Use a distinct spec tag such as `spec-v0.6.2` **only once a separate publication decision authorizes it**.
