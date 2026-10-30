/**
 * Mocked recovery rehearsal (PR-11, COMMIT-RECOVERY-SAFETY condition 2
 * evidence).
 *
 * Drives the REAL `DurableQuoteStore`, `DurableMutationCoordinator`,
 * and Chargebee live-adapter code over mocked Chargebee transports
 * and temporary SQLite databases, and verifies each failure/recovery
 * scenario against the outcome class the protocol requires.
 *
 * What this evidence is: procedural readiness — the recovery
 * machinery behaves as specified when exercised end to end.
 * What it is NOT:
 * - not live evidence (every transport is mocked; classifications
 *   use the repository's honest SIMULATED vocabulary);
 * - not proof of durable exactly-once provider execution — durable
 *   storage plus idempotency keys bound retries to at-most-once
 *   DISPATCH from this process's ledger, and Chargebee's native
 *   idempotency window is time-limited; neither is a server-enforced
 *   exactly-once guarantee;
 * - not a named operator's acceptance of the reconciliation runbook
 *   (condition 4 remains a human act);
 * - never a conversion of INDETERMINATE into a safe retry: matching
 *   state alone does not establish execution (PR-7 review L1).
 *
 * PR-14 (Issue #22, Finding 1) reclassification: the live adapter's
 * update commits are now refused pre-dispatch by the authorization
 * preservation gate (its only dispatch is a full-list replacement
 * on a FULL_REPLACEMENT_ONLY capability, which cannot preserve
 * unrelated state under OPERATION authorization). The adapter-level
 * scenarios that previously rehearsed dispatch outcomes
 * (rh-01/02/03/06/07/08/09/14) now rehearse the refusal and the
 * unreachability of their former fault classes through this
 * adapter; rh-13's unresolved attempt is constructed at the
 * coordinator/ledger level (the construction rh-04/rh-05 always
 * used), because the adapter no longer creates one. Scenario ids
 * are retained from PR-11/PR-12 for evidence continuity; titles and
 * expected outcomes state the current behavior. The INDETERMINATE /
 * COMMITTED_UNVERIFIED / VIOLATED classification machinery is
 * unchanged and remains rehearsed at the ledger level (rh-04/05/13)
 * and in the simulator and store suites.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ChargebeeClient, type HttpTransport } from "../chargebee-http.js";
import { ChargebeeLiveAdapter, buildChargebeeUpdateParams } from "../chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "./mock-transport.js";
import { DurableQuoteStore, DispatchBlockedError } from "../../store/durable-store.js";
import { DurableMutationCoordinator } from "../../store/mutation-coordinator.js";
import { SCQError } from "../../core/types.js";
import type { StoredQuote } from "../../store/quote-store.js";

/**
 * Minimal durable quote record for the coordinator-level scenarios
 * (mirrors the shape the durable-store suites use; the adapter-level
 * scenarios build real quotes through the adapter instead).
 */
function rehearsalQuote(quoteId: string): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "chargebee",
    subscription_id: SUB,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: ADDON, quantity: 21 }],
      effectiveIntent: { type: "IMMEDIATE" },
    } as StoredQuote["proposal"],
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: {
      immediateFinancialEffect: "REVALIDATE",
      recurringFinancialEffect: "REVALIDATE",
      termEffect: "UNKNOWN",
      effectiveAt: "REVALIDATE",
    },
    multi_change_consistency: "BEST_EFFORT",
    provider_preview_input: { items: [{ itemPriceId: ADDON, quantity: 21 }], idempotencyKey: `scq-${quoteId}` },
    quoted_effect: { immediate: { net: 20000 }, recurring: { resultingAmount: 80900, currency: "usd" } },
    created_at: "2026-10-29T00:00:00.000Z",
    expires_at: "2026-10-29T01:00:00.000Z",
    status: "ACTIVE",
  };
}

const require2 = createRequire(import.meta.url);
const Database = require2("better-sqlite3") as any;

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const SITE = "pilot-test";

const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

export type RehearsalScenarioResult = {
  id: string;
  title: string;
  expectedOutcome: string;
  observedOutcome: string;
  pass: boolean;
  evidence: string;
};

export type RehearsalResult = {
  generatedAt: string;
  /** Rehearsal evidence is simulated by construction. */
  evidenceClass: "SIMULATED_PASS" | "SIMULATED_FAIL";
  scenarios: RehearsalScenarioResult[];
  scenariosPassed: number;
  scenariosTotal: number;
  allPassed: boolean;
  limits: string[];
};

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "scq-pr11-rh-")), "scq.db");
}

type Counted = { transport: HttpTransport; dispatches: () => number };

function counted(mock: PilotMockChargebee, wrap?: (inner: HttpTransport) => HttpTransport): Counted {
  let updateDispatches = 0;
  const base: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("update_for_items")) updateDispatches++;
    return mock.transport(req);
  };
  return { transport: wrap ? wrap(base) : base, dispatches: () => updateDispatches };
}

function adapterFor(store: DurableQuoteStore, transport: HttpTransport): ChargebeeLiveAdapter {
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, transport);
  return new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true, // rehearsal only: dispatch targets the MOCKED transport
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: SITE,
  });
}

function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}

async function quoteAndCommit(faults: PilotMockFaults = {}, wrap?: (inner: HttpTransport) => HttpTransport) {
  const path = tmpDb();
  const mock = new PilotMockChargebee(faults);
  const c = counted(mock, wrap);
  const store = openStore(path);
  const adapter = adapterFor(store, c.transport);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  return { path, mock, counted: c, store, adapter, quoteId: quote.id };
}

function result(id: string, title: string, expectedOutcome: string, observedOutcome: string, pass: boolean, evidence: string): RehearsalScenarioResult {
  return { id, title, expectedOutcome, observedOutcome, pass, evidence };
}

const GATE_CODE = "AUTHORIZATION_PRESERVATION_UNENFORCEABLE";

/** PR-14: runs a commit and reports the refusal's code + recorded outcome class. */
async function commitRefusal(adapter: ChargebeeLiveAdapter, quoteId: string): Promise<{ code: string; outcome: string }> {
  try {
    const receipt = await adapter.commitChangeQuote(quoteId);
    return { code: "NO_REFUSAL", outcome: String(receipt.outcome ?? receipt.status) };
  } catch (e) {
    return {
      code: e instanceof SCQError ? String(e.code) : "error",
      outcome: e instanceof SCQError ? String((e.details as any)?.outcome ?? e.code) : "error",
    };
  }
}

async function rh01(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, counted: c } = await quoteAndCommit();
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const attempts = store.allAttempts().filter((a) => a.quoteId === quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && c.dispatches() === 0 && attempts.length === 0 && stored?.commit_receipt === undefined && stored?.commit_outcome?.outcome === "CONFIRMED_NON_EXECUTION";
  store.close();
  return result("rh-01-successful-dispatch", "Update commit refuses pre-dispatch — authorization preservation gate (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome,
    pass, `refusal ${refusal.code}: no dispatch was made (update dispatches: ${c.dispatches()}), no durable attempt was created, no receipt was recorded, and the quote's recorded outcome is CONFIRMED_NON_EXECUTION. PR-14 migration: this scenario previously rehearsed a successful COMMITTED_AND_VERIFIED dispatch; the adapter's full-list replacement dispatch is now refused for OPERATION-authorized quotes because preservation of unrelated state cannot be enforced (Issue #22 Finding 1). The scenario id is retained from PR-11 for evidence continuity.`);
}

async function rh02(): Promise<RehearsalScenarioResult> {
  const { path, store, adapter, quoteId, mock } = await quoteAndCommit();
  const first = await commitRefusal(adapter, quoteId);
  store.close();
  const reopened = openStore(path);
  const adapter2 = adapterFor(reopened, mock.transport as HttpTransport);
  const second = await commitRefusal(adapter2, quoteId);
  const pass = first.code === GATE_CODE && second.code === GATE_CODE && first.outcome === second.outcome && mock.mutationCount === 0 && reopened.allAttempts().length === 0 && reopened.get(quoteId)?.commit_receipt === undefined;
  const evidence = `both commits — before and after the restart — refused with the identical ${GATE_CODE} / ${first.outcome}; provider mutation count ${mock.mutationCount}; no receipt was ever recorded, so §6.10 replay has nothing to replay for a refused commit and the refusal itself is the deterministic replay. PR-14 migration of the former exact-receipt-replay scenario (id retained for evidence continuity).`;
  reopened.close();
  return result("rh-02-exact-receipt-replay", "Preservation refusal is deterministic across restart — no receipt exists to replay (PR-14)", "CONFIRMED_NON_EXECUTION", second.outcome, pass, evidence);
}

async function rh03(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, mock } = await quoteAndCommit({ loseUpdateResponse: true });
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && stored?.commit_outcome?.outcome === "CONFIRMED_NON_EXECUTION" && mock.mutationCount === 0;
  const evidence = `the lose-response fault was armed on the mock but never exercised: the commit dispatched nothing (provider mutation count ${mock.mutationCount}), so no response existed to lose and SCQ records no receipt. The refusal is CONFIRMED_NON_EXECUTION — a pre-dispatch preservation refusal is never classified INDETERMINATE. Lost-response INDETERMINATE semantics remain rehearsed at the ledger level by rh-04/rh-05. PR-14 migration (id retained for evidence continuity).`;
  store.close();
  return result("rh-03-lost-response", "Armed lost-response fault is never exercised — the refusal precedes dispatch (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass, evidence);
}

async function rh04(): Promise<RehearsalScenarioResult> {
  const path = tmpDb();
  const store = openStore(path);
  const quote = rehearsalQuote("rh04-quote");
  store.put(quote);
  const coordinator = new DurableMutationCoordinator(store, {
    afterIntentPersisted: () => { throw new Error("simulated crash after write-ahead intent"); },
  });
  let dispatchRan = 0;
  const intent = {
    quoteId: quote.quote_id, subscriptionId: SUB, provider: "chargebee" as const, site: SITE,
    request: buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 21 }]),
    idempotencyKey: `scq-${quote.quote_id}`,
  };
  await coordinator.execute(intent, async () => { dispatchRan++; return { type: "outcome" as const, outcome: "INDETERMINATE" as const }; }).catch(() => undefined);
  // The writer is abandoned WITHOUT close(), as a crashed process would be.
  const reopened = openStore(path);
  const attempt = reopened.allAttempts().find((a) => a.quoteId === quote.quote_id);
  const stored = reopened.get(quote.quote_id);
  const pass = dispatchRan === 0 && attempt?.state === "INDETERMINATE" && stored?.commit_outcome?.outcome === "INDETERMINATE";
  const evidence = `dispatch ran ${dispatchRan} times (the crash preceded it); on reopen the stale DISPATCHING attempt recovered as INDETERMINATE and the blind-retry guard recorded the outcome on the quote`;
  reopened.close();
  return result("rh-04-crash-after-intent", "Crash after write-ahead intent persisted", "INDETERMINATE", attempt?.state ?? "missing", pass, evidence);
}

async function rh05(): Promise<RehearsalScenarioResult> {
  const path = tmpDb();
  const store = openStore(path);
  const quote = rehearsalQuote("rh05-quote");
  store.put(quote);
  const mock = new PilotMockChargebee();
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const coordinator = new DurableMutationCoordinator(store, {
    afterDispatchBeforePersist: () => { throw new Error("simulated crash after dispatch, before receipt persistence"); },
  });
  const intent = {
    quoteId: quote.quote_id, subscriptionId: SUB, provider: "chargebee" as const, site: SITE,
    request: buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 21 }]),
    idempotencyKey: `scq-${quote.quote_id}`,
  };
  await coordinator.execute(intent, async () => {
    await client.updateForItems(SUB, intent.request, intent.idempotencyKey);
    return { type: "outcome" as const, outcome: "INDETERMINATE" as const };
  }).catch(() => undefined);
  // Writer abandoned without close().
  const reopened = openStore(path);
  const attempt = reopened.allAttempts().find((a) => a.quoteId === quote.quote_id);
  const stored = reopened.get(quote.quote_id);
  const pass = mock.mutationCount === 1 && attempt?.state === "INDETERMINATE" && stored?.commit_receipt === undefined;
  const evidence = `the provider-side dispatch DID occur (mock mutation count ${mock.mutationCount}) but no receipt was ever persisted; recovery classifies the attempt INDETERMINATE and the quote holds no receipt — a landed effect without a durable record is uncertainty, not a commit`;
  reopened.close();
  return result("rh-05-crash-after-dispatch", "Crash after dispatch, before receipt persistence", "INDETERMINATE", attempt?.state ?? "missing", pass, evidence);
}

async function rh06(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, mock } = await quoteAndCommit({ silentIgnoreUpdate: true });
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && mock.mutationCount === 0;
  store.close();
  return result("rh-06-wrong-item-set", "Armed silent-ignore fault is never exercised — the refusal precedes dispatch (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass,
    `the silent-ignore fault was armed on the mock but never exercised: refusal ${GATE_CODE} preceded any dispatch (provider mutation count ${mock.mutationCount}), so no success-shaped response existed to misread, and no receipt is recorded. The success-shaped-but-unapplied classification remains implemented in the dispatch path for a future permitting capability. PR-14 migration (id retained for evidence continuity).`);
}

async function rh07(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, mock } = await quoteAndCommit({ mandatoryAddonOnUpdate: "pilot-addon-mandatory" });
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && mock.mutationCount === 0;
  store.close();
  return result("rh-07-mandatory-addon", "Provider-attached-item hazard class removed — the refusal precedes dispatch (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass,
    `the mock was armed to attach pilot-addon-mandatory on update, but refusal ${GATE_CODE} preceded any dispatch (provider mutation count ${mock.mutationCount}): an item outside the authorized change can no longer appear in a landed set through this adapter at all — the preservation hazard class this scenario formerly recorded as a reconciliation VIOLATED receipt is removed by refusing the unsafe dispatch, not by detecting its result. Attributable-VIOLATED receipt semantics remain implemented for permitting capabilities and are covered by the simulator suites. PR-14 migration (id retained for evidence continuity).`);
}

async function rh08(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, mock } = await quoteAndCommit({ incompleteUpdateResponse: true });
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && mock.mutationCount === 0;
  store.close();
  return result("rh-08-unknown-financials", "Unknown-financials response class unreachable — the refusal precedes dispatch (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass,
    `the incomplete-response fault was armed but never exercised: refusal ${GATE_CODE} preceded any dispatch (provider mutation count ${mock.mutationCount}), so no landed commit exists whose financials could be unknown, and no receipt is recorded. The COMMITTED_UNVERIFIED classification remains implemented in the dispatch path and is covered by the simulator and store suites. PR-14 migration (id retained for evidence continuity).`);
}

async function rh09(): Promise<RehearsalScenarioResult> {
  const { store, adapter, quoteId, mock } = await quoteAndCommit();
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && mock.mutationCount === 0;
  const evidence = `refusal ${GATE_CODE} preceded any dispatch (provider mutation count ${mock.mutationCount}), so no committed receipt exists whose post-commit actuals could violate the envelope. PR-14 migration: this scenario formerly inflated post-commit re-reads to manufacture an established envelope violation on a committed receipt — that outcome class is unreachable through this adapter while the preservation gate refuses its only dispatch. Pre-commit envelope enforcement (QUOTE_DRIFTED, before any dispatch) is unaffected and remains covered by the adapter suites. Scenario id retained for evidence continuity.`;
  store.close();
  return result("rh-09-envelope-violation", "Post-commit envelope-violation class unreachable — the refusal precedes dispatch (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass, evidence);
}

async function rh10(): Promise<RehearsalScenarioResult> {
  const path = tmpDb();
  const store = openStore(path);
  const qA = rehearsalQuote("rh10-a");
  const qB = rehearsalQuote("rh10-b");
  store.put(qA); store.put(qB);
  const request = buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 21 }]);
  const first = store.beginDispatch({ quoteId: qA.quote_id, subscriptionId: SUB, provider: "chargebee", site: SITE, request, idempotencyKey: `scq-${qA.quote_id}` });
  let refused = false;
  try {
    store.beginDispatch({ quoteId: qB.quote_id, subscriptionId: SUB, provider: "chargebee", site: SITE, request, idempotencyKey: `scq-${qB.quote_id}` });
  } catch (e) { refused = e instanceof DispatchBlockedError; }
  const unresolved = store.allAttempts().filter((a) => a.state === "DISPATCHING" || a.state === "PREPARED");
  const pass = refused && unresolved.length === 1 && unresolved[0].attemptId === first.attemptId;
  store.recordAttemptOutcome(first.attemptId, "CONFIRMED_NON_EXECUTION", { reason: "rehearsal cleanup" });
  store.close();
  return result("rh-10-concurrent-same-subscription", "Concurrent attempts on the same subscription", "DispatchBlockedError", refused ? "DispatchBlockedError" : "not refused", pass,
    "the second beginDispatch on the same subscription was refused while the first attempt was unresolved; exactly one attempt proceeds — the exclusion is enforced inside the ledger transaction, not by convention");
}

async function rh11(): Promise<RehearsalScenarioResult> {
  const path = tmpDb();
  const store = openStore(path);
  const quote = rehearsalQuote("rh11-quote");
  store.put(quote);
  const coordinator = new DurableMutationCoordinator(store);
  const key = `scq-${quote.quote_id}`;
  const attempt = coordinator.beginDispatch({
    quoteId: quote.quote_id, subscriptionId: SUB, provider: "chargebee", site: SITE,
    request: buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 21 }]), idempotencyKey: key,
  });
  store.recordAttemptOutcome(attempt.attemptId, "CONFIRMED_NON_EXECUTION", { reason: "rehearsal: settle the first use of the key" });
  let refused = false;
  let detail = "";
  try {
    coordinator.beginDispatch({
      quoteId: quote.quote_id, subscriptionId: SUB, provider: "chargebee", site: SITE,
      request: buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 99 }]), idempotencyKey: key,
    });
  } catch (e) { refused = true; detail = e instanceof Error ? e.message : String(e); }
  const pass = refused;
  store.close();
  return result("rh-11-idempotency-key-conflict", "Idempotency-key conflict (same key, different request)", "refusal", refused ? "refusal" : "not refused", pass,
    `reusing the key with a different request was refused by the ledger (${detail.slice(0, 120)}); Chargebee's own native idempotency window is time-limited and is never treated as retry-safety proof`);
}

async function rh12(): Promise<RehearsalScenarioResult> {
  const path = tmpDb();
  const store = openStore(path);
  const quote = rehearsalQuote("rh12-quote");
  store.put(quote);
  store.close();
  const db = new Database(path);
  const row = db.prepare("SELECT record_json FROM quotes WHERE quote_id = ?").get(quote.quote_id) as { record_json: string };
  const tampered = row.record_json.replace('"quantity":21', '"quantity":99');
  db.prepare("UPDATE quotes SET record_json = ? WHERE quote_id = ?").run(tampered === row.record_json ? row.record_json + " " : tampered, quote.quote_id);
  db.close();
  let refused = false;
  try { openStore(path).close(); } catch { refused = true; }
  const inspection = DurableQuoteStore.inspect(path);
  const corrupt = inspection.corruptRecords.find((r) => r.quoteId === quote.quote_id);
  const pass = refused && corrupt !== undefined;
  return result("rh-12-corrupted-records", "Partial/corrupted durable records", "adoption refused", refused ? "adoption refused" : "adopted", pass,
    `opening the store refused adoption of the tampered record (integrity hash mismatch) and inspect() reports the record as corrupt; nothing is silently recovered or partially adopted`);
}

async function rh13(): Promise<RehearsalScenarioResult> {
  // PR-14: the unresolved attempt is constructed at the
  // coordinator/ledger level — the construction rh-04/rh-05 always
  // used — because the live adapter no longer creates one: its
  // update commits refuse at the preservation gate before the
  // ledger. The operator-review semantics under rehearsal are
  // unchanged.
  const path = tmpDb();
  const store = openStore(path);
  const quote = rehearsalQuote("rh13-quote");
  store.put(quote);
  const mock = new PilotMockChargebee({ loseUpdateResponse: true });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const coordinator = new DurableMutationCoordinator(store);
  const intent = {
    quoteId: quote.quote_id, subscriptionId: SUB, provider: "chargebee" as const, site: SITE,
    request: buildChargebeeUpdateParams([{ itemPriceId: ADDON, quantity: 21 }]),
    idempotencyKey: `scq-${quote.quote_id}`,
  };
  await coordinator.execute(intent, async () => {
    // The mocked dispatch's response is lost (armed fault); the
    // coordinator records the attempt INDETERMINATE — execution is
    // never inferred from state.
    await client.updateForItems(SUB, intent.request, intent.idempotencyKey).catch(() => undefined);
    return { type: "outcome" as const, outcome: "INDETERMINATE" as const };
  }).catch(() => undefined);
  store.close();
  const reopened = openStore(path);
  const report = reopened.recoveryReport();
  const entry = report.indeterminateOutcomes.find((a) => a.quoteId === quote.quote_id);
  const stillUnresolved = reopened.allAttempts().some((a) => a.quoteId === quote.quote_id && a.state === "INDETERMINATE");
  const pass = !!entry && entry.state === "INDETERMINATE" && entry.operatorInterventionRequired === true && stillUnresolved;
  const evidence = `recoveryReport lists the attempt as INDETERMINATE with operator intervention required (next permitted action: ${String(entry?.nextPermittedAction ?? "n/a")}); producing the report changed nothing — the attempt remains unresolved until a human resolves it through the append-only record. PR-14: the attempt was constructed at the coordinator/ledger level because the live adapter's preservation gate now refuses OPERATION-authorized update commits before the ledger; the review semantics rehearsed here are unchanged`;
  reopened.close();
  return result("rh-13-operator-review-unresolved", "Operator review of an unresolved attempt", "INDETERMINATE", String(entry?.state ?? "missing"), pass, evidence);
}

async function rh14(): Promise<RehearsalScenarioResult> {
  const rejecting: (inner: HttpTransport) => HttpTransport = (inner) => async (req) => {
    if (req.method === "POST" && req.url.includes("update_for_items")) {
      return { status: 400, headers: {}, json: { type: "invalid_request", api_error_code: "param_wrong_value", message: "subscription_items[item_price_id][0] : value does not meet the required specification", http_status_code: 400 } };
    }
    return inner(req);
  };
  const { store, adapter, quoteId, mock } = await quoteAndCommit({}, rejecting);
  const refusal = await commitRefusal(adapter, quoteId);
  const stored = store.get(quoteId);
  const attempts = store.allAttempts().filter((a) => a.quoteId === quoteId);
  const pass = refusal.code === GATE_CODE && refusal.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_outcome?.outcome === "CONFIRMED_NON_EXECUTION" && stored?.commit_receipt === undefined && mock.mutationCount === 0 && attempts.length === 0;
  store.close();
  return result("rh-14-pre-effect-rejection", "Preservation gate precedes the provider's pre-effect rejection (PR-14)", "CONFIRMED_NON_EXECUTION", refusal.outcome, pass,
    `the rejecting transport was armed to answer any update dispatch with HTTP 400 param_wrong_value, but no dispatch occurred (provider mutation count ${mock.mutationCount}, zero ledger attempts): the PR-14 preservation gate (${GATE_CODE}) refused the commit first, recording CONFIRMED_NON_EXECUTION on the quote. PR-14 migration: the allowlisted pre-effect rejection classification remains implemented in the adapter's dispatch path — only that narrow, code-allowlisted shape earns CONFIRMED_NON_EXECUTION from a provider response — but through this adapter the gate now fires before it, so this scenario rehearses the gate's precedence (id retained for evidence continuity).`);
}

export async function runRehearsal(): Promise<RehearsalResult> {
  const scenarios: RehearsalScenarioResult[] = [];
  for (const fn of [rh01, rh02, rh03, rh04, rh05, rh06, rh07, rh08, rh09, rh10, rh11, rh12, rh13, rh14]) {
    try {
      scenarios.push(await fn());
    } catch (e) {
      scenarios.push(result(fn.name, fn.name, "scenario completion", "error", false, `scenario threw: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const scenariosPassed = scenarios.filter((s) => s.pass).length;
  return {
    generatedAt: new Date().toISOString(),
    evidenceClass: scenariosPassed === scenarios.length ? "SIMULATED_PASS" : "SIMULATED_FAIL",
    scenarios,
    scenariosPassed,
    scenariosTotal: scenarios.length,
    allPassed: scenariosPassed === scenarios.length,
    limits: [
      "All transports are mocked and all databases are temporary: this is SIMULATED evidence, never live evidence.",
      "The rehearsal proves the recovery machinery's behavior, not durable exactly-once provider execution; no such guarantee is claimed.",
      "A completed rehearsal is procedural readiness only. It does not name or bind a reconciliation operator (condition 4) and grants no commit authorization (condition 5).",
    ],
  };
}
