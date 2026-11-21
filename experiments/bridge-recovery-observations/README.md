# Experimental bridge recovery observations

This source-only fixture exercises the existing bridge against the **unmodified SCQ source baseline** `8597852e918fb31e1470e4b5aa3b50fd2df00dcd`. It does not implement a recovery protocol or change a package API. The npm package excludes the experimental bridge.

## Run

Use Linux and Node 24 (verified on v24.22.1), npm, and native SQLite build support if a prebuilt binding is unavailable. Start with this repository checked out to the exact review commit from the pinned link, in a disposable parent directory. From its root:

```bash
review_root="$PWD"
git clone https://github.com/agorail-labs/subscription-change-quote.git ../scq-recovery-baseline
git -C ../scq-recovery-baseline checkout --detach 8597852e918fb31e1470e4b5aa3b50fd2df00dcd
cd ../scq-recovery-baseline/reference
npm ci --no-audit --no-fund
npm run build
AGORAIL_SCQ_REFERENCE="$PWD" node --test "$review_root/experiments/bridge-recovery-observations/paused-worker.test.mjs"
```

The runner rejects the wrong source commit or tracked source edits. The fixture uses real child processes and SQLite, synthetic authorization/admission/commercial callbacks, and append-only **local-file effects**. Each test uses disposable databases. No provider credentials, network writes, real customer approval, PIC SDK, or actual MSE admission are involved. The coordinator subclass pauses before the original coordinator begins its attempt; the production bridge and store are unmodified.

## Expected outputs

Five tests pass, with zero skipped. Two passing tests deliberately demonstrate unsafe counterexamples; a green run is **not** evidence of a safe recovery implementation.

| Case | Expected observation |
| --- | --- |
| Retain claim | No SCQ attempt at the pause; second caller BLOCKED; resumed original dispatches once; original receipt replays. |
| Unsupported deletion, counterexample only | The replacement settles q2, then the paused original settles q1: two local-file effects for one business intent. Deletion is only on a disposable test database; no product release API exists. |
| Approval withdrawn before entry | Authorization refuses; no claim, attempt or effect. |
| Approval withdrawn after reservation, counterexample | No replacement or takeover occurs. The original's entry authorization has passed, but approval is withdrawn before SCQ dispatch authorization. On resumption, the bridge does not recheck its hook and one local-file effect occurs. This is a limitation relative to a proposed dispatch-time approval contract, not desired behavior. |
| Provider result lost, then approval withdrawn | One local-file effect, INDETERMINATE attempt and no receipt. Before revocation the claim blocks q2; after revocation authorization refuses. Neither produces a second effect or turns uncertainty into non-execution. |

For the existing baseline bridge tests, from the source baseline's `reference/` directory:

```bash
node --test dist/tests/test62-business-intent-bridge.test.js dist/tests/test67-mse-scq-bridge-process-kill.test.js
```

Expected: 14 pass, zero skipped on Linux. The older process-kill fixture and this paused-worker fixture test different failure modes.

## What remains unproven

These tests do not implement or prove serialized takeover, old-generation exclusion, a non-bypassable dispatch authority, distributed approval-revocation ordering, real-provider finality, or exactly-once provider effects. A late approval check alone leaves a check-to-send race. A future design must serialize recovery with dispatch authorization and define what revocation accepted before that boundary means. Potentially dispatched work requires operation-bound reconciliation; a matching resource snapshot is insufficient.

A read-only observation contract must keep NONE_FOUND separate from UNAVAILABLE or INTEGRITY_FAILURE, identify the store/intent/quote and observation scope, and avoid claiming an atomic snapshot across independent databases. No inspection, claim-release or takeover API is added by this fixture.

