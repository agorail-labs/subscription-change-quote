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
 *     as MULTISETS of complete item TUPLES — (identifier,
 *     quantity, offering where the expectation states offerings) —
 *     never as independent quantity and offering lists, which
 *     would accept a pairing that exists in neither set. Without
 *     it, coverage is ACTION_LEVEL — the historical per-change
 *     checks — and the result's limitations say plainly that state
 *     outside the targeted items is not examined.
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
 *   - CANCEL: "terminal now" is not "cancelled at the authorized
 *     time". A terminal state verifies an IMMEDIATE intent. A
 *     non-terminal state contradicts an IMMEDIATE intent (an
 *     established TERM_END schedule does not rescue it — a
 *     scheduled cancellation is not an immediate termination).
 *     For TERM_END / DATE intents, verification requires
 *     independently established schedule evidence
 *     (`cancellationSchedule`) whose KIND or INSTANT aligns with
 *     the authorized intent: TERM_END verifies from provider
 *     schedule-kind evidence, or from an established instant equal
 *     to the authorized term boundary carried on the EXPECTATION
 *     side (`termBoundaryAt` — never a boundary read out of the
 *     observed snapshot, which would be the state proving itself);
 *     a schedule whose kind and instant cannot be aligned is
 *     UNVERIFIABLE, and an established instant contradicting the
 *     authorized boundary/date is MISMATCH. For a terminal DATE /
 *     TERM_END state, the established cancellation instant is
 *     compared the same way: earlier than authorized is a
 *     premature termination (MISMATCH, the Paddle P3 precedent);
 *     no established instant at all is UNVERIFIABLE — a bare
 *     terminal status cannot distinguish premature from compliant
 *     (the one exception: a DATE intent read back BEFORE its
 *     authorized date with the subscription already terminal
 *     establishes prematurity from the read time itself). A
 *     schedule is never invented.
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

/**
 * The identifier of a collection entry, or undefined when the
 * entry cannot carry one. Totality (SV3): provider collections
 * are runtime data — an entry may be null, a primitive, or an
 * object without a usable id — and every dereference of an entry
 * goes through this guard so malformed entries compute
 * UNVERIFIABLE instead of throwing.
 */
function entryId(entry: unknown): string | undefined {
  if (entry === null || (typeof entry !== "object" && typeof entry !== "function")) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function groupById<T extends { id?: unknown }>(entries: ReadonlyArray<T>): Map<string, T[]> {
  const byId = new Map<string, T[]>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id === undefined) continue;
    const list = byId.get(id) ?? [];
    list.push(entry);
    byId.set(id, list);
  }
  return byId;
}

type ItemShape = { quantity?: number; offeringRef?: string };

/** Multiset surplus: the values whose observed multiplicity exceeds the expected multiplicity (each repeated per excess occurrence). */
function multisetSurplus<T>(expected: ReadonlyArray<T>, observed: ReadonlyArray<T>): T[] {
  const remaining = new Map<T, number>();
  for (const value of expected) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const surplus: T[] = [];
  for (const value of observed) {
    const left = remaining.get(value) ?? 0;
    if (left > 0) remaining.set(value, left - 1);
    else surplus.push(value);
  }
  return surplus;
}

function multisetsEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  return a.length === b.length && multisetSurplus(a, b).length === 0;
}

function tupleLabel(entry: ItemShape, includeOffering: boolean): string {
  return includeOffering ? `(quantity ${entry.quantity}, offering ${entry.offeringRef})` : `(quantity ${entry.quantity})`;
}

function tupleList(entries: ReadonlyArray<ItemShape>, includeOffering: boolean): string {
  return entries.map((e) => tupleLabel(e, includeOffering)).join(", ");
}

/**
 * The FULL_ITEM_SET comparison (SV1): expected vs observed as
 * multisets of complete item TUPLES — (identifier, quantity, and
 * offering where the expectation states offerings) — never as
 * independent per-dimension lists: comparing sorted quantities
 * and sorted offerings separately accepts a quantity/offering
 * PAIRING that exists in neither set. Emits one check entry per
 * established problem (or per unverifiable aspect), or a single
 * VERIFIED entry.
 *
 * Malformed entries (SV3): an entry without a usable identifier
 * cannot be compared. On the OBSERVED side it makes the dimension
 * unverifiable and suppresses absence-based judgments (the entry
 * might BE the apparently-missing item), while contradictions
 * established by present, identified entries still stand. On the
 * EXPECTED side the expectation itself is compromised, so no
 * contradiction is fabricated from it: the dimension is
 * unverifiable.
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
  const unidentifiableObserved = observed.filter((e) => entryId(e) === undefined).length;
  const unidentifiableExpected = expected.filter((e) => entryId(e) === undefined).length;
  if (unidentifiableObserved > 0) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "UNVERIFIABLE",
      `${unidentifiableObserved} observed item entr${unidentifiableObserved === 1 ? "y carries" : "ies carry"} no identifier and cannot be compared against the expected set`
    );
  }
  if (unidentifiableExpected > 0) {
    col.add(
      "item-set",
      DIM_ITEM_SET,
      "UNVERIFIABLE",
      `${unidentifiableExpected} expected item entr${unidentifiableExpected === 1 ? "y carries" : "ies carry"} no identifier — the expected set itself is malformed, so no item-set conclusion can be drawn from it`
    );
    if (!complete) {
      col.add(
        "item-set",
        DIM_ITEM_SET,
        "UNVERIFIABLE",
        "the item collection is a partial return (itemsComplete: false): items absent from it are not established " +
          "as missing, and unreturned items cannot be ruled out — the item-set dimension cannot be fully verified " +
          "from a partial collection"
      );
    }
    return;
  }
  // An absence (an expected identifier with too few identified
  // observed entries) is established only from a complete
  // collection with no unidentifiable entries that could account
  // for the shortfall. Present-entry contradictions are unaffected.
  const absenceEstablished = complete && unidentifiableObserved === 0;
  const expectedById = groupById(expected);
  const observedById = groupById(observed);
  const ids = new Set([...expectedById.keys(), ...observedById.keys()]);
  let problems = 0;
  const addMissing = (id: string, exp: ReadonlyArray<ItemShape>, obs: ReadonlyArray<ItemShape>): void => {
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
  };
  for (const id of ids) {
    const exp = (expectedById.get(id) ?? []) as ReadonlyArray<ItemShape>;
    const obs = (observedById.get(id) ?? []) as ReadonlyArray<ItemShape>;
    if (obs.length > exp.length) {
      problems += 1;
      if (exp.length === 0) {
        col.add("item-set", DIM_ITEM_SET, "CONTRADICTED", `extra item ${id} (actual quantity ${obs[0].quantity})`);
      } else {
        col.add("item-set", DIM_ITEM_SET, "CONTRADICTED", `duplicate entries for item ${id} (×${obs.length})`);
      }
      continue;
    }
    if (exp.length === 0) continue; // id present in neither (defensive; unreachable via the union)

    const offeringRequired = exp.some((e) => typeof e.offeringRef === "string");
    const quantitiesOf = (entries: ReadonlyArray<ItemShape>): number[] | undefined =>
      entries.every((e) => typeof e.quantity === "number" && Number.isFinite(e.quantity))
        ? entries.map((e) => e.quantity as number)
        : undefined;
    const offeringsOf = (entries: ReadonlyArray<ItemShape>): string[] | undefined =>
      entries.every((e) => typeof e.offeringRef === "string") ? entries.map((e) => e.offeringRef as string) : undefined;
    const expQ = quantitiesOf(exp);
    const obsQ = quantitiesOf(obs);
    const expO = offeringRequired ? offeringsOf(exp) : undefined;
    const obsO = offeringRequired ? offeringsOf(obs) : undefined;
    const tupleComparable = expQ !== undefined && obsQ !== undefined && (!offeringRequired || (expO !== undefined && obsO !== undefined));

    if (tupleComparable) {
      // Canonical tuple multiset for this identifier.
      const keyOf = (e: ItemShape): string => JSON.stringify([e.quantity, offeringRequired ? e.offeringRef : null]);
      const surplusKeys = multisetSurplus(exp.map(keyOf), obs.map(keyOf));
      if (obs.length < exp.length) {
        if (surplusKeys.length > 0) {
          // A PRESENT tuple that exists nowhere in the expected
          // configuration: established by the entry itself, even
          // in a partial return and even below expected
          // multiplicity — it is not an absence-based judgment.
          problems += 1;
          const surplusEntries = surplusKeys.map((k) => obs.find((e) => keyOf(e) === k) as ItemShape);
          col.add(
            "item-set",
            DIM_ITEM_SET,
            "CONTRADICTED",
            `item configuration mismatch for item ${id}: observed tuple ${tupleList(surplusEntries, offeringRequired)} is not part of the expected item configuration`
          );
        } else if (absenceEstablished) {
          addMissing(id, exp, obs);
        }
        continue;
      }
      // Equal multiplicity.
      if (surplusKeys.length === 0) continue; // the tuple multiset matches exactly
      problems += 1;
      const qtyEqual = multisetsEqual(expQ as number[], obsQ as number[]);
      const offEqual = !offeringRequired || multisetsEqual(expO as string[], obsO as string[]);
      if (!qtyEqual && offEqual) {
        const sortedExp = [...(expQ as number[])].sort((a, b) => a - b);
        const sortedObs = [...(obsQ as number[])].sort((a, b) => a - b);
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          exp.length === 1
            ? `quantity mismatch for item ${id}: intended ${(expQ as number[])[0]}, actual ${(obsQ as number[])[0]}`
            : `quantity mismatch for item ${id}: intended quantities [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
        );
      } else if (qtyEqual && !offEqual) {
        const sortedExp = [...(expO as string[])].sort();
        const sortedObs = [...(obsO as string[])].sort();
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          (expO as string[]).length === 1
            ? `offering mismatch for item ${id}: intended ${sortedExp[0]}, actual ${sortedObs[0]}`
            : `offering mismatch for item ${id}: intended [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
        );
      } else if (qtyEqual && offEqual) {
        // The SV1 case: each dimension matches independently, but
        // no expected (quantity, offering) pairing actually exists.
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          `item configuration mismatch for item ${id}: the quantities and offerings match independently, but their pairing differs — expected tuples ${tupleList(exp, offeringRequired)}, actual tuples ${tupleList(obs, offeringRequired)}`
        );
      } else {
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          `item configuration mismatch for item ${id}: expected tuples ${tupleList(exp, offeringRequired)}, actual tuples ${tupleList(obs, offeringRequired)}`
        );
      }
      continue;
    }

    // The full tuple cannot be formed for this identifier (a
    // quantity or a required offering is absent on one side): the
    // dimension is unverifiable for the incompletely shaped part,
    // while each completely shaped dimension is still compared on
    // its own — a contradiction established by present entries in
    // a shaped dimension stands.
    if (expQ === undefined || obsQ === undefined) {
      const side = expQ === undefined ? "expected" : "observed";
      col.add(
        "item-set",
        DIM_ITEM_SET,
        "UNVERIFIABLE",
        `the quantity of item ${id} is absent from the ${side} set — its resulting quantity cannot be verified`
      );
    } else if (offeringRequired && (expO === undefined || obsO === undefined)) {
      const side = expO === undefined ? "expected" : "observed";
      col.add(
        "item-set",
        DIM_ITEM_SET,
        "UNVERIFIABLE",
        `the offering of item ${id} is absent from the ${side} set — its resulting offering cannot be verified`
      );
    }
    let establishedProblem = false;
    if (expQ !== undefined && obsQ !== undefined) {
      const surplusQ = multisetSurplus(expQ, obsQ);
      if (surplusQ.length > 0 && obs.length < exp.length) {
        problems += 1;
        establishedProblem = true;
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          exp.length === 1
            ? `quantity mismatch for item ${id}: intended ${expQ[0]}, actual ${surplusQ[0]}`
            : `quantity mismatch for item ${id}: observed quantity ${surplusQ[0]} is not part of the expected quantities [${[...expQ].sort((a, b) => a - b).join(", ")}]`
        );
      } else if (obs.length === exp.length && !multisetsEqual(expQ, obsQ)) {
        problems += 1;
        establishedProblem = true;
        const sortedExp = [...expQ].sort((a, b) => a - b);
        const sortedObs = [...obsQ].sort((a, b) => a - b);
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          exp.length === 1
            ? `quantity mismatch for item ${id}: intended ${expQ[0]}, actual ${obsQ[0]}`
            : `quantity mismatch for item ${id}: intended quantities [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
        );
      }
    }
    if (offeringRequired && expO !== undefined && obsO !== undefined) {
      const surplusO = multisetSurplus(expO, obsO);
      if (surplusO.length > 0 && obs.length < exp.length) {
        problems += 1;
        establishedProblem = true;
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          expO.length === 1
            ? `offering mismatch for item ${id}: intended ${expO[0]}, actual ${surplusO[0]}`
            : `offering mismatch for item ${id}: observed offering ${surplusO[0]} is not part of the expected offerings [${[...expO].sort().join(", ")}]`
        );
      } else if (obs.length === exp.length && !multisetsEqual(expO, obsO)) {
        problems += 1;
        establishedProblem = true;
        const sortedExp = [...expO].sort();
        const sortedObs = [...obsO].sort();
        col.add(
          "item-set",
          DIM_ITEM_SET,
          "CONTRADICTED",
          expO.length === 1
            ? `offering mismatch for item ${id}: intended ${sortedExp[0]}, actual ${sortedObs[0]}`
            : `offering mismatch for item ${id}: intended [${sortedExp.join(", ")}], actual [${sortedObs.join(", ")}]`
        );
      }
    }
    if (obs.length < exp.length && absenceEstablished && !establishedProblem) {
      addMissing(id, exp, obs);
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
      "the observed item collection establishes the expected resulting item set exactly (multiset of complete item tuples: identifiers, quantities, and stated offerings)"
    );
  }
}

/** One per-change check, with the §6.12 action-level semantics (see the module header for the CANCEL schedule extension). */
function checkChange(
  change: PostCommitStateExpectation["proposal"]["changes"][number],
  index: number,
  proposal: PostCommitStateExpectation["proposal"],
  expectation: PostCommitStateExpectation,
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
      const item = snapshot.items.find((candidate) => entryId(candidate) === change.itemId);
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
      const item = snapshot.items.find((candidate) => entryId(candidate) === change.itemId);
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
      const intent = proposal.effectiveIntent;
      const schedule = observation.cancellationSchedule;
      const terminal = TERMINAL_SUBSCRIPTION_STATES.has(status.toLowerCase());
      // The authorized instant the cancellation is supposed to
      // take effect, where the intent type carries one: for DATE
      // the intended date itself; for TERM_END the authorized
      // term boundary, which only the EXPECTATION side may supply
      // (expectation.termBoundaryAt) — a boundary read from the
      // observed snapshot (billing.nextBillingAt,
      // term.commitmentUntil) would be the state proving itself
      // and is never used. IMMEDIATE carries no future instant.
      const authorizedAt = intent?.type === "DATE" ? intent.at : intent?.type === "TERM_END" ? expectation.termBoundaryAt : undefined;
      const kind = schedule?.kind;
      const effectiveAt = typeof schedule?.effectiveAt === "string" && schedule.effectiveAt.length > 0 ? schedule.effectiveAt : undefined;
      // Compare an established instant against the authorized one:
      // "earlier" | "equal" | "later" | undefined (either side
      // missing or unparseable-and-unequal — unalignable).
      const compareInstants = (established: string | undefined, authorized: string | undefined): "earlier" | "equal" | "later" | undefined => {
        if (established === undefined || authorized === undefined) return undefined;
        const a = Date.parse(established);
        const b = Date.parse(authorized);
        if (Number.isNaN(a) || Number.isNaN(b)) return established === authorized ? "equal" : undefined;
        return a < b ? "earlier" : a > b ? "later" : "equal";
      };
      const prematureDetail = (established: string, authorized: string): string =>
        intent?.type === "TERM_END"
          ? `the subscription was cancelled effective ${established}, before the authorized term boundary ${authorized} — a premature termination, not the authorized term-end cancellation`
          : `the subscription was cancelled effective ${established}, before the intended date ${authorized} — a premature termination, not the authorized cancellation`;
      if (terminal) {
        if (intent?.type !== "DATE" && intent?.type !== "TERM_END") {
          // IMMEDIATE (or an intent-less cancel): terminal now IS
          // the authorized outcome.
          col.add(name, DIM_CANCELLATION, "VERIFIED", `the subscription is in the terminal state "${status}"`);
          return;
        }
        // Scheduled intent, already terminal (SV2): an
        // established cancellation instant decides first — it
        // overrides kind evidence, exactly as on the
        // not-yet-effective path. Provider schedule-kind evidence
        // matching the intent kind is the provider's own
        // attestation that the termination is the scheduled one,
        // and verifies only when no established instant
        // contradicts it.
        const cmp = compareInstants(effectiveAt, authorizedAt);
        if (cmp === "equal") {
          col.add(name, DIM_CANCELLATION, "VERIFIED", `the subscription is in the terminal state "${status}" and the established cancellation instant ${effectiveAt} matches the authorized instant`);
          return;
        }
        if (cmp === "earlier") {
          col.add(name, DIM_CANCELLATION, "CONTRADICTED", prematureDetail(effectiveAt as string, authorizedAt as string));
          return;
        }
        if (cmp === "later") {
          col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the subscription was cancelled effective ${effectiveAt}, after the authorized instant ${authorizedAt} — not the authorized cancellation`);
          return;
        }
        if (kind === intent.type) {
          col.add(
            name,
            DIM_CANCELLATION,
            "VERIFIED",
            `the subscription is in the terminal state "${status}" and the established cancellation evidence carries the ${intent.type} schedule kind — the scheduled cancellation took effect`
          );
          return;
        }
        if (intent.type === "TERM_END" && authorizedAt === undefined) {
          // No boundary was supplied and no kind evidence: if the
          // evidence carries an instant it cannot be aligned with
          // anything, so nothing here is MISMATCH evidence either.
          col.add(
            name,
            DIM_CANCELLATION,
            "UNVERIFIABLE",
            `the subscription is in the terminal state "${status}", but no authorized term boundary was supplied with the expectation and the established cancellation evidence carries no TERM_END schedule kind — the termination cannot be aligned with the authorized term end`
          );
          return;
        }
        if (intent.type === "DATE") {
          // No established cancellation instant. For a DATE intent
          // the read time itself can still establish prematurity:
          // already terminal BEFORE the authorized date means the
          // cancellation took effect early. Read at/after the
          // date, premature-vs-compliant is indistinguishable.
          const observedMs = Date.parse(observation.observedAt ?? "");
          const intendedMs = Date.parse(authorizedAt as string);
          if (!Number.isNaN(observedMs) && !Number.isNaN(intendedMs) && observedMs < intendedMs) {
            col.add(
              name,
              DIM_CANCELLATION,
              "CONTRADICTED",
              `the subscription is already in the terminal state "${status}" when read at ${observation.observedAt}, before the intended date ${authorizedAt} — a premature termination, not the authorized cancellation`
            );
            return;
          }
        }
        col.add(
          name,
          DIM_CANCELLATION,
          "UNVERIFIABLE",
          `the subscription is in the terminal state "${status}", but the established evidence carries no aligned cancellation instant — a terminal state alone cannot distinguish a premature termination from the authorized ${intent.type} cancellation`
        );
        return;
      }
      // Non-terminal.
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
          if (kind !== undefined && kind !== "DATE") {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established cancellation schedule is of kind ${kind}, not the intended DATE schedule`);
            return;
          }
          if (effectiveAt === undefined) {
            col.add(name, DIM_CANCELLATION, "UNVERIFIABLE", "the established cancellation schedule carries no effective date; the intended DATE cannot be verified against it");
            return;
          }
          const cmp = compareInstants(effectiveAt, authorizedAt);
          if (cmp === undefined) {
            col.add(name, DIM_CANCELLATION, "UNVERIFIABLE", `the established cancellation schedule date ${effectiveAt} cannot be aligned with the intended date ${authorizedAt}`);
            return;
          }
          if (cmp !== "equal") {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established cancellation schedule is effective ${effectiveAt}, not the intended date ${authorizedAt}`);
            return;
          }
          col.add(name, DIM_CANCELLATION, "VERIFIED", `a cancellation schedule effective ${effectiveAt} is independently established, matching the intended date, while the subscription remains "${status}"`);
          return;
        }
        if (intent?.type === "TERM_END") {
          if (kind !== undefined && kind !== "TERM_END") {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established cancellation schedule is of kind ${kind}, not the intended TERM_END schedule`);
            return;
          }
          if (kind === "TERM_END") {
            // Provider schedule-kind evidence: the provider
            // attests the schedule IS a term-end schedule. An
            // established instant, where it contradicts a supplied
            // authorized boundary, still overrides.
            const cmpB = compareInstants(effectiveAt, authorizedAt);
            if (cmpB === "earlier") {
              col.add(name, DIM_CANCELLATION, "CONTRADICTED", prematureDetail(effectiveAt as string, authorizedAt as string));
              return;
            }
            if (cmpB === "later") {
              col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established term-end cancellation is effective ${effectiveAt}, after the authorized term boundary ${authorizedAt} — not the authorized cancellation`);
              return;
            }
            col.add(
              name,
              DIM_CANCELLATION,
              "VERIFIED",
              `a TERM_END cancellation schedule${effectiveAt ? ` effective ${effectiveAt}` : ""} is independently established by provider schedule-kind evidence while the subscription remains "${status}" — the scheduled cancellation is established`
            );
            return;
          }
          // No kind evidence: only an established instant equal
          // to the authorized boundary aligns.
          const cmp = compareInstants(effectiveAt, authorizedAt);
          if (cmp === "equal") {
            col.add(name, DIM_CANCELLATION, "VERIFIED", `a cancellation schedule effective ${effectiveAt} is independently established, equal to the authorized term boundary, while the subscription remains "${status}"`);
            return;
          }
          if (cmp === "earlier") {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", prematureDetail(effectiveAt as string, authorizedAt as string));
            return;
          }
          if (cmp === "later") {
            col.add(name, DIM_CANCELLATION, "CONTRADICTED", `the established cancellation schedule is effective ${effectiveAt}, after the authorized term boundary ${authorizedAt} — not the authorized cancellation`);
            return;
          }
          col.add(
            name,
            DIM_CANCELLATION,
            "UNVERIFIABLE",
            authorizedAt === undefined
              ? `a cancellation schedule${effectiveAt ? ` effective ${effectiveAt}` : ""} was established, but no authorized term boundary was supplied with the expectation and the schedule carries no TERM_END kind evidence — the schedule cannot be aligned with the authorized term end`
              : `the established cancellation schedule${effectiveAt ? ` (effective ${effectiveAt})` : ""} cannot be aligned with the authorized term boundary ${authorizedAt} — its kind and instant do not establish a term-end cancellation`
          );
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
      checkChange(change, i, proposal, expectation, snapshot, observation, col);
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
