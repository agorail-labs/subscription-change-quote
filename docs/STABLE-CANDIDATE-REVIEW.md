# Stable-Candidate Review Package — SCQ 1.0.0-rc.1 (prepared)

**Status: PREPARED — NO REVIEWER HAS BEEN CONTACTED.** Independent
review is a release gate (see `docs/RELEASE-QUALIFICATION.md`).
Candidate reviewers and prioritization live in
`docs/launch-materials/reviewer-worksheet.md` (internal; Fabio —
the Issue #22 external reviewer — is first). Contact is the
maintainer's decision, one reviewer at a time.

## What to evaluate

1. **API usability** — the five-minute quickstart, then the API
   reference (`docs/API-REFERENCE.md`) against the real surface.
2. **Contract consistency** — `docs/STABLE-RELEASE-READINESS.md`
   §2–§3 against behavior, especially the §2.4 trust limitations.
3. **Threat-model completeness** — `docs/SECURITY-AUDIT.md`, the
   spec's security considerations, and your own probing.
4. **Crash and concurrency safety** — kill processes mid-dispatch,
   race processes on one database, corrupt the store. The Phase 3
   suite (`test70`) is the floor, not the ceiling: the most
   valuable review breaks something it doesn't.
5. **Package reproducibility** — build from source; compare the
   export surface to `docs/api/public-api.snapshot.json`; attempt
   the checksum reproduction and report what you observe
   (blocker B-SCQ-3 is an open, honestly-held unknown).
6. **Negative cases and failure reporting** — expired quotes,
   UNKNOWN amounts, envelope violations, INDETERMINATE resolution
   with weak evidence: does it fail closed, and does it say why?

## What counts as a substantive evaluation

A written report with **reproducible evidence** — commands,
inputs, outputs, commit/version. At least one of the two required
evaluations should be adversarial (security or
transactional-systems). Stars, reactions, invitations, and
unsupported opinions do not count.
