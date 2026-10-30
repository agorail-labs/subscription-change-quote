// Durable mutation coordinator (SCQ v0.6.2, PR-8).
//
// The explicit boundary between a provider adapter and the durable
// store. The existing synchronous QuoteStore interface cannot hide
// transactional failure, so this coordinator does not pretend
// otherwise: every step either commits durably or throws, and a
// persistence failure NEVER falls back to in-memory state.
//
// Protocol (write-ahead):
//   1. Replay check: a recorded receipt for the quote is returned
//      verbatim (§6.10) — no dispatch is authorized.
//   2. beginDispatch: the intent (quote, subscription, provider,
//      site, exact canonical request + hash, idempotency key,
//      attempt identity, pre-dispatch fingerprint) and the
//      PREPARED → DISPATCHING transition commit in ONE transaction.
//   3. Only then is the caller's dispatch function invoked — at
//      most once per authorization.
//   4. The dispatch result is settled atomically: a receipt via
//      recordAttemptReceipt (quote row + receipt record + attempt
//      terminal state in one transaction), or a no-receipt outcome
//      via recordAttemptOutcome. A dispatch that throws (lost
//      response, transport failure) is settled INDETERMINATE and
//      the error re-thrown: execution cannot be established, no
//      receipt exists, and the attempt blocks any blind retry —
//      including after a process restart (PR #16 L1).
//
// This yields exactly-once RECORDING and at-most-once dispatch
// AUTHORIZATION. It does not yield exactly-once provider execution.

import { SCQError, type MutationOutcome, type SubscriptionChangeReceipt } from "../core/types.js";
import {
  DispatchBlockedError,
  DurableQuoteStore,
  type MutationIntent,
  type StoredAttempt,
} from "./durable-store.js";

export { DispatchBlockedError };
export type { MutationIntent, StoredAttempt };

export type DispatchResult =
  | { type: "receipt"; receipt: SubscriptionChangeReceipt }
  | { type: "outcome"; outcome: MutationOutcome; details?: unknown };

export type ExecuteResult =
  | { type: "replay"; receipt: SubscriptionChangeReceipt; attempt?: StoredAttempt }
  | { type: "settled"; receipt?: SubscriptionChangeReceipt; outcome?: MutationOutcome; attempt: StoredAttempt };

export type CoordinatorHooks = {
  /** Runs after the write-ahead intent + DISPATCHING transition have durably committed, before dispatch. Crash tests exit the process here. */
  afterIntentPersisted?: (attempt: StoredAttempt) => void;
  /** Runs after dispatch returns a result, before the result is persisted. Crash tests exit the process here. */
  afterDispatchBeforePersist?: (attempt: StoredAttempt, result: DispatchResult) => void;
};

export class DurableMutationCoordinator {
  constructor(
    readonly store: DurableQuoteStore,
    private readonly hooks: CoordinatorHooks = {},
  ) {}

  /**
   * Runs one mutation under the write-ahead protocol.
   * `dispatch` performs the provider call exactly once and reports
   * its result; it must not retry internally.
   */
  async execute(intent: MutationIntent, dispatch: () => Promise<DispatchResult>): Promise<ExecuteResult> {
    const replay = this.store.recordedReceipt(intent.quoteId);
    if (replay) return { type: "replay", receipt: replay };

    const attempt = this.store.beginDispatch(intent);
    // beginDispatch returns an existing TERMINAL attempt when the
    // same key + identical request already settled: serve its
    // recorded outcome without a new dispatch.
    if (attempt.state === "COMMITTED_AND_VERIFIED" || attempt.state === "COMMITTED_UNVERIFIED") {
      const receipt = this.store.recordedReceipt(intent.quoteId);
      if (receipt) return { type: "replay", receipt, attempt };
    }
    if (attempt.state !== "DISPATCHING") {
      throw new DispatchBlockedError(`Dispatch blocked: attempt ${attempt.attemptId} is ${attempt.state}.`, { attemptId: attempt.attemptId, state: attempt.state });
    }

    this.hooks.afterIntentPersisted?.(attempt);

    let result: DispatchResult;
    try {
      result = await dispatch();
    } catch (e) {
      // The dispatch was authorized and attempted; its execution
      // cannot be established or excluded. Settle INDETERMINATE
      // (durable, blocking) and re-throw — never a receipt, never
      // a silent retry.
      this.store.recordAttemptOutcome(attempt.attemptId, "INDETERMINATE", {
        reason: "dispatch threw after write-ahead authorization; execution cannot be established",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    this.hooks.afterDispatchBeforePersist?.(attempt, result);

    if (result.type === "receipt") {
      const recorded = this.store.recordAttemptReceipt(attempt.attemptId, result.receipt);
      return { type: "settled", receipt: recorded, attempt: this.store.getAttempt(attempt.attemptId)! };
    }
    this.store.recordAttemptOutcome(attempt.attemptId, result.outcome, result.details);
    return { type: "settled", outcome: result.outcome, attempt: this.store.getAttempt(attempt.attemptId)! };
  }

  /** Adapter-wiring entry point: the write-ahead gate alone (adapter dispatch code runs between begin and settle). */
  beginDispatch(intent: MutationIntent): StoredAttempt {
    const replay = this.store.recordedReceipt(intent.quoteId);
    if (replay) {
      throw new SCQError("CHANGE_CONFLICT", `Quote ${intent.quoteId} already has a recorded receipt; replay it instead of dispatching.`, { replay: true });
    }
    const attempt = this.store.beginDispatch(intent);
    if (attempt.state !== "DISPATCHING") {
      throw new DispatchBlockedError(`Dispatch blocked: attempt ${attempt.attemptId} is ${attempt.state}.`, { attemptId: attempt.attemptId, state: attempt.state });
    }
    return attempt;
  }

  /** Adapter-wiring exit point: settle the attempt from the quote's durable terminal record. */
  settleFromStore(attemptId: string): StoredAttempt {
    return this.store.settleAttemptFromStore(attemptId);
  }

  /** Read-only operator enumeration (performs no action). */
  recoveryReport() {
    return this.store.recoveryReport();
  }
}
