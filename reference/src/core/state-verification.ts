/**
 * v0.6.2 (PR-9): the provider-neutral post-commit STATE
 * verification hook — issue #7 Topic 5.
 *
 * `verifyPostCommitState` computes — never accepts — whether the
 * state a committed change INTENDED is the state a post-commit
 * provider read OBSERVED. It generalizes the §6.12 state
 * verification that previously existed only as a private function
 * inside the store (where it served `establishVerification`
 * alone) into one shared core computation that the store and the
 * adapters consume identically. Placement: core, importing types
 * only — the store and every adapter already depend on core, and
 * core depends on neither, so there is no import cycle.
 *
 * WHAT THIS FUNCTION IS — AND IS NOT. It answers exactly one of
 * the four questions verification is made of: (1) is the intended
 * state observed? It does not answer (2) did the operation
 * execute, (3) is the observed state attributable to the
 * operation, or (4) are the financial figures established — the
 * result type carries those as constant-false fields so the
 * boundary is structural, not just documented. Consequences, all
 * pinned by test31:
 *   - a VERIFIED state never upgrades a lost-response
 *     INDETERMINATE attempt (PR #16 L1): a matching state is
 *     observationally identical to another actor's identical
 *     change;
 *   - a VERIFIED state under a broken attribution bracket creates
 *     no established recurring figure and no verified receipt
 *     (Z1/Z3): establishment and classification stay with the
 *     operation-bound evidence in the adapters;
 *   - a state MISMATCH is never, by itself, a financial VIOLATED:
 *     that translation requires independently attributable
 *     financial evidence.
 * The result is a VALUE, not evidence: it carries no brand, and
 * `verifyCommitReceipt` refuses it exactly as it refuses any
 * unbranded object (test31.25). Branding stays at the
 * `establishVerification` boundary; binding an observation to a
 * real provider read stays the adapters' duty.
 *
 * SEMANTICS (research/core-state-verification.md §4–§5):
 *   - Coverage is reported, never implied. With `expectedItems`,
 *     coverage is FULL_ITEM_SET: expected vs observed are compared
 *     as MULTISETS over item identifiers + quantities (+ stated
 *     offerings). Without it, coverage is ACTION_LEVEL — the
 *     historical per-change checks — and the result's limitations
 *     say plainly that state outside the targeted items is not
 *     examined.
 *   - An OMITTED item collection is UNVERIFIABLE, never an empty
 *     set; a present EMPTY collection against a nonempty
 *     expectation is a MISMATCH (a stated empty set is data).
 *   - A PARTIAL collection (itemsComplete: false): contradictions
 *     established by PRESENT entries stand; absence-based
 *     contradictions are NOT established (an unreturned item is
 *     not a missing item); the item-set dimension is then at best
 *     UNVERIFIABLE.
 *   - Precedence: any established contradiction => MISMATCH (a
 *     determined negative verification never collapses into
 *     UNVERIFIABLE); else any unverifiable required check =>
 *     UNVERIFIABLE; else VERIFIED — only when every required check
 *     passed.
 *   - CANCEL: a terminal state verifies any intent. A non-terminal
 *     state contradicts an IMMEDIATE intent (an established
 *     TERM_END schedule does not rescue it — a scheduled
 *     cancellation is not an immediate termination). For a
 *     TERM_END / DATE intent, verification requires independently
 *     established schedule evidence (`cancellationSchedule`); the
 *     snapshot carries no schedule, so without it the check is
 *     UNVERIFIABLE — a schedule is never invented. For a DATE
 *     intent the established date must equal the intended date.
 */
import type {
  PostCommitObservedSnapshot,
  PostCommitStateExpectation,
  PostCommitStateObservation,
  PostCommitStateVerification,
  StateVerificationCheck,
} from "./types.js";

const TERMINAL_SUBSCRIPTION_STATES: ReadonlySet<string> = new Set(["cancelled", "canceled", "terminated"]);

const DIM_ITEM_SET = "state:itemSet";
const DIM_CADENCE = "state:cadence";
const DIM_CANCELLATION = "state:cancellation";

type CheckOutcome = StateVerificationCheck["outcome"];

class CheckCollector {
  readonly checks: StateVerificationCheck[] = [];
  readonly contradictions: string[] = [];

  add(check: string, dimension: string, outcome: CheckOutcome, detail: string): void {
    this.checks.push({ check, dimension, outcome, detail });
    if (outcome === "CONTRADICTED") this.contradictions.push(detail);
  }

  get sawUnverifiable(): boolean {
    return this.checks.some((c) => c.outcome === "UNVERIFIABLE");
  }

  dimensionsWith(outcome: CheckOutcome): string[] {
    const seen: string[] = [];
    for (const c of this.checks) {
      if (c.outcome === outcome && !seen.includes(c.dimension)) seen.push(c.dimension);
    }
    return seen;
  }
}

function groupById<T extends { id?: unknown }>(entries: ReadonlyArray<T>): Map<string, T[]> {
  const byId = new Map<string, T[]>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const list = byId.get(entry.id) ?? [];
    list.push(entry);
    byId.set(entry.id, list);
  }
  return byId;
}

/**
 * The FULL_ITEM_SET comparison: expected vs observed as multisets
 * over item identifiers, per-identifier quantities, and stated
 * offerings. Emits one check entry per established problem (or per
 * unverifiable aspect), or a single VERIFIED entry.
 */
function compareItemSets(
  expected: NonNullable<PostCommitStateExpectation["expectedItems"]>,
  snapshot: PostCommitObservedSnapshot,
  observation: PostCommitStateObservation,
  col: CheckCollector
): void {
  const observed = snapshot.items;
  if (!Array.isArray(observed)) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "UNVERIFIABLE",
      "the observation omits the item collection — an omitted collection is unverifiable, never an empty set"
    );
    return;
  }
  const complete = observation.itemsComplete !== false;
  const unidentifiable = observed.filter((e) => typeof e?.id !== "string" || e.id.length === 0).length;
  if (unidentifiable > 0) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "UNVERIFIABLE",
      `${unidentifiable} observed item entr${unidentifiable === 1 ? "y carries" : "ies carry"} no identifier and cannot be compared against the expected set`
    );
  }
  const expectedById = groupById(expected);
  const observedById = groupById(observed);
  const ids = new Set([...expectedById.keys(), ...observedById.keys()]);
  let problems = 0;
  for (const id of ids) {
    const exp = expectedById.get(id) ?? [];
    const obs = observedById.get(id) ?? [];
    if (obs.length > exp.length) {
      problems += 1;
      if (exp.length === 0) {
        col.add("item-set", DIM_ITEM_SET, "CONTRADICTED", `extra item ${id} (actual quantity ${obs[0].quantity})`);
      } else {
        col.add("item-set", DIM_ITEM_SET, "CONTRADICTED", `duplicate entries for item ${id} (×${obs.length})`);
      }
      continue;
    }
    if (obs.length < exp.length) {
      if (complete) {
        problems += 1;
        if (obs.length === 0) {
          col.add(
            "item-set",
            DIM_ITEM_SET,
            "CONTRADICTED",
            exp[0].quantity === undefined ? `missing item ${id}` : `missing item ${id} (intended quantity ${exp[0].quantity})`
          );
        } else {
          col.add(
            "item-set",
            DIM_ITEM_SET,
            "CONTRADICTED",
            `item ${id} appears ${exp.length} times in the expected set but ${obs.length} times in the observed set`
          );
        }
      }
      // Partial collection: absence is not established; the
      // partial rule below marks the dimension unverifiable.
      continue;
    }
    if (exp.length === 0) continue; // id present in neither (defensive; unreachable via the union)
    // Equal multiplicity: compare the quantity multiset.
    const quantitiesOf = (entries: ReadonlyArray<{ quantity?: number }>): number[] | undefined =>
      entries.every((e) => typeof e.quantity === "number") ? entries.map((e) => e.quantity as number) : undefined;
    const expQ = quantitiesOf(exp);
    const obsQ = quantitiesOf(obs);
    if (expQ === undefined || obsQ === undefined) {
      const side = expQ === undefined ? "expected" : "observed";
      col.add(
        "item-set",
        DIM_ITEM_SET,
        "UNVERIFIABLE",
        `the quantity of item ${id} is absent from the ${side} set — its resulting quantity cannot be verified`
      );
    } else {
      const sortedExp = [...expQ].sort((a, b) => a - b);
      const sortedObs = [...obsQ].sort((a, b) => a - b);
      if (JSON.stringify(sortedExp) !== JSON.stringify(sortedObs)) {
        problems += 1;
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          exp.length === 1
            ? `quantity mismatch for item ${id}: intended ${expQ[0]}, actual ${obsQ[0]}`
            : `quantity mismatch for item ${id}: intended quantities [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
        );
        continue;
      }
    }
    // Offerings, where the expectation states them.
    const expOfferings = exp.map((e) => e.offeringRef).filter((o): o is string => typeof o === "string");
    if (expOfferings.length > 0) {
      if (obs.some((e) => typeof e.offeringRef !== "string")) {
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "UNVERIFIABLE",
          `the offering of item ${id} is absent from the observed set — its resulting offering cannot be verified`
        );
      } else {
        const obsOfferings = obs.map((e) => e.offeringRef as string);
        const sortedExp = [...expOfferings].sort();
        const sortedObs = [...obsOfferings].sort();
        if (JSON.stringify(sortedExp) !== JSON.stringify(sortedObs)) {
          problems += 1;
          col.add(
            "item-set",
            DIM_ITEM_SET,
            "CONTRADICTED",
            expOfferings.length === 1
              ? `offering mismatch for item ${id}: intended ${sortedExp[0]}, actual ${sortedObs[0]}`
              : `offering mismatch for item ${id}: intended [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
          );
        }
      }
    }
  }
  if (!complete) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "UNVERIFIABLE",
      "the item collection is a partial return (itemsComplete: false): items absent from it are not established " +
        "as missing, and unreturned items cannot be ruled out — the item-set dimension cannot be fully verified " +
        "from a partial collection"
    );
    return;
  }
  if (problems === 0 && !col.checks.some((c) => c.dimension === DIM_ITEM_SET)) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "VERIFIED",
      "the observed item collection establishes the expected resulting item set exactly (multiset over identifiers and quantities)"
    );
  }
}

/** One per-change check, with the §6.12 action-level semantics (see the module header for the CANCEL schedule extension). */
function checkChange(
  change: PostCommitStateExpectation["proposal"]["changes"][number],
  index: number,
  proposal: PostCommitStateExpectation["proposal"],
  snapshot: PostCommitObservedSnapshot,
  observation: PostCommitStateObservation,
  col: CheckCollector
): void {
  const name = `change[${index}]:${change?.action}`;
  switch (change?.action) {
    case "CHANGE_QUANTITY": {
      const dimension = `state:item:${change.itemId}:quantity`;
      if (!Array.isArray(snapshot.items)) {
        col.add(name, dimension, "UNVERIFIABLE", `the observation omits the item collection; the resulting quantity of item ${change.itemId} cannot be verified`);
        return;
      }
      const item = snapshot.items.find((candidate) => candidate.id === change.itemId);
      if (!item) {
        col.add(name, dimension, "CONTRADICTED", `item ${change.itemId} is absent from the observed post-commit state (intended quantity ${change.quantity})`);
        return;
      }
      if (typeof item.quantity !== "number") {
        col.add(name, dimension, "UNVERIFIABLE", `the observed entry for item ${change.itemId} carries no quantity; its resulting quantity cannot be verified`);
        return;
      }
      if (item.quantity !== change.quantity) {
        col.add(name, dimension, "CONTRADICTED", `quantity mismatch for item ${change.itemId}: intended ${change.quantity}, actual ${item.quantity}`);
        return;
      }
      col.add(name, dimension, "VERIFIED", `item ${change.itemId} is present at the intended quantity ${change.quantity}`);
      return;
    }
    case "CHANGE_PLAN": {
      const dimension = `state:item:${change.itemId}:offering`;
      if (!Array.isArray(snapshot.items)) {
        col.add(name, dimension, "UNVERIFIABLE", `the observation omits the item collection; the resulting offering of item ${change.itemId} cannot be verified`);
        return;
      }
      const item = snapshot.items.find((candidate) => candidate.id === change.itemId);
      if (!item) {
        col.add(name, dimension, "CONTRADICTED", `item ${change.itemId} is absent from the observed post-commit state (intended offering ${change.offeringRef})`);
        return;
      }
      if (item.offeringRef !== change.offeringRef) {
        col.add(name, dimension, "CONTRADICTED", `offering mismatch for item ${change.itemId}: intended ${change.offeringRef}, actual ${item.offeringRef}`);
        return;
      }
      col.add(name, dimension, "VERIFIED", `item ${change.itemId} carries the intended offering ${change.offeringRef}`);
      return;
    }
    case "CHANGE_CADENCE": {
      const cadence = snapshot.billing?.cadence;
      if (typeof cadence !== "string" || cadence.length === 0) {
        col.add(name, DIM_CADENCE, "UNVERIFIABLE", "the observed billing cadence is absent; the resulting cadence cannot be verified");
        return;
      }
      if (cadence.toUpperCase() !== change.cadence) {
        col.add(name, DIM_CADENCE, "CONTRADICTED", `cadence mismatch: intended ${change.cadence}, actual ${cadence}`);
        return;
      }
      col.add(name, DIM_CADENCE, "VERIFIED", `the observed billing cadence is ${change.cadence}`);
      return;
    }
    case "CANCEL": {
      const status = snapshot.status;
      if (typeof status !== "string" || status.length === 0) {
        col.add(name, DIM_CANCELLATION, "UNVERIFIABLE", "the observed subscription status is absent; the cancellation cannot be verified");
        return;
      }
      if (TERMINAL_SUBSCRIPTION_STATES.has(status.toLowerCase())) {
        col.add(name, DIM_CANCELLATION, "VERIFIED", `the subscription is in the terminal state "${status}"`);
        return;
      }
      const intent = proposal.effectiveIntent;
      const schedule = observation.cancellationSchedule;
      if (intent?.type === "IMMEDIATE") {
        col.add(
          name,
          DIM_CANCELLATION,
          "CONTRADICTED",
          schedule
            ? `the subscription is still "${status}" with a cancellation scheduled${schedule.effectiveAt ? ` for ${schedule.effectiveAt}` : ""} — a scheduled cancellation is not an immediate termination`
            : `the subscription is still "${status}", not in a terminal state`
        );
        return;
      }
      if (schedule) {
        if (intent?.type === "DATE") {
          if (typeof schedule.effectiveAt !== "string" || schedule.effectiveAt.length === 0) {
            col.add(name, DIM_CANCELLATION, "UNVERIFIABLE", "the established cancellation schedule carries no effective date; the intended DATE cannot be verified against it");
            return;
          }
          const intendedMs = Date.parse(intent.at);
          const scheduledMs = Date.parse(schedule.effectiveAt);
          const equal =
            Number.isNaN(intendedMs) || Number.isNaN(scheduledMs)
              ? schedule.effectiveAt === intent.at
              : scheduledMs === intendedMs;
          if (!equal) {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established cancellation schedule is effective ${schedule.effectiveAt}, not the intended date ${intent.at}`);
            return;
          }
          col.add(name, DIM_CANCELLATION, "VERIFIED", `a cancellation schedule effective ${schedule.effectiveAt} is independently established, matching the intended date, while the subscription remains "${status}"`);
          return;
        }
        col.add(
          name,
          DIM_CANCELLATION,
          "VERIFIED",
          `a cancellation schedule${schedule.effectiveAt ? ` effective ${schedule.effectiveAt}` : ""} is independently established while the subscription remains "${status}" — the scheduled cancellation is established`
        );
        return;
      }
      col.add(
        name,
        DIM_CANCELLATION,
        "UNVERIFIABLE",
        `the subscription is still "${status}" and no cancellation schedule was independently established — the snapshot carries no schedule, so a scheduled cancellation cannot be verified from the status field alone`
      );
      return;
    }
    default:
      col.add(name, "state:proposal", "UNVERIFIABLE", `unrecognized change action ${JSON.stringify((change as { action?: unknown } | undefined)?.action)}; its intended state cannot be verified`);
  }
}

/**
 * Compute the post-commit state verification. Pure and total: it
 * never throws on malformed input — what cannot be checked
 * computes UNVERIFIABLE, what is contradicted computes MISMATCH,
 * and VERIFIED is reachable only when every required check passed.
 */
export function verifyPostCommitState(
  expectation: PostCommitStateExpectation,
  observation: PostCommitStateObservation
): PostCommitStateVerification {
  const col = new CheckCollector();
  const proposal = expectation?.proposal;
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : [];
  const expectedItems = expectation?.expectedItems;
  const coverage: PostCommitStateVerification["coverage"] = expectedItems !== undefined ? "FULL_ITEM_SET" : "ACTION_LEVEL";
  const snapshot = observation?.snapshot;
  const limitations: string[] = [
    "This verification establishes only whether the intended state is observed in the post-commit read. It does " +
      "not establish that the operation executed, that the observed state is attributable to this operation, or " +
      "any financial outcome — execution, attribution, and financial establishment are separate questions, " +
      "answered (if at all) by operation-bound evidence outside this result.",
  ];
  if (coverage === "ACTION_LEVEL") {
    limitations.push(
      "Coverage is action-level: only the items and dimensions the proposal's changes target were checked. " +
        "Additions, removals, or duplications outside the targeted items are not detected at this coverage; " +
        "full item-set verification requires the expected resulting item set (expectedItems)."
    );
  } else if (changes.some((c) => c?.action === "CHANGE_QUANTITY" || c?.action === "CHANGE_PLAN")) {
    limitations.push("Per-change CHANGE_QUANTITY / CHANGE_PLAN checks are subsumed by the full item-set comparison and were not performed separately.");
  }
  if (observation?.itemsComplete === false) {
    limitations.push("The item collection was reported as a partial return (itemsComplete: false): absence-based contradictions were not established from it.");
  }

  if (!snapshot) {
    limitations.push("No post-commit snapshot was observed; nothing about the resulting state is established.");
    if (expectedItems !== undefined) {
      col.add("item-set", DIM_ITEM_SET, "UNVERIFIABLE", "no post-commit snapshot was observed; the item set cannot be verified");
    }
    changes.forEach((change, i) => {
      const dimension =
        change?.action === "CHANGE_QUANTITY"
          ? `state:item:${change.itemId}:quantity`
          : change?.action === "CHANGE_PLAN"
            ? `state:item:${change.itemId}:offering`
            : change?.action === "CHANGE_CADENCE"
              ? DIM_CADENCE
              : change?.action === "CANCEL"
                ? DIM_CANCELLATION
                : "state:proposal";
      col.add(`change[${i}]:${change?.action}`, dimension, "UNVERIFIABLE", "no post-commit snapshot was observed; this check cannot be performed");
    });
    if (expectedItems === undefined && changes.length === 0) {
      col.add("proposal", "state:proposal", "UNVERIFIABLE", "the proposal carries no changes; there is no intended state to verify");
    }
  } else {
    if (expectedItems !== undefined) compareItemSets(expectedItems, snapshot, observation, col);
    changes.forEach((change, i) => {
      // At FULL_ITEM_SET coverage the item-set comparison subsumes
      // the per-change item checks; cadence and cancellation are
      // not item dimensions and are always checked per change.
      if (coverage === "FULL_ITEM_SET" && (change?.action === "CHANGE_QUANTITY" || change?.action === "CHANGE_PLAN")) return;
      checkChange(change, i, proposal, snapshot, observation, col);
    });
    if (expectedItems === undefined && changes.length === 0) {
      col.add("proposal", "state:proposal", "UNVERIFIABLE", "the proposal carries no changes; there is no intended state to verify");
    }
  }

  const verdict: PostCommitStateVerification["verdict"] =
    col.contradictions.length > 0 ? "MISMATCH" : col.sawUnverifiable || col.checks.length === 0 ? "UNVERIFIABLE" : "VERIFIED";

  return {
    verdict,
    coverage,
    checks: col.checks,
    verifiedDimensions: col.dimensionsWith("VERIFIED"),
    contradictions: col.contradictions,
    unverifiableDimensions: col.dimensionsWith("UNVERIFIABLE"),
    stateObserved: snapshot !== undefined && snapshot !== null,
    executionEstablished: false,
    stateAttributableToThisOperation: false,
    financialOutcomeEstablished: false,
    provenance: {
      source: observation?.source ?? "(unspecified)",
      ...(observation?.observedAt ? { observedAt: observation.observedAt } : {}),
    },
    limitations,
  };
}
