/**
 * SCQ quick start — Scenario B: when the landed change diverges.
 *
 * SIMULATOR ONLY. ChargebeeSim is an in-memory, provider-shaped model;
 * this file makes no real billing API call. Amounts are minor units.
 *
 * A commit that "succeeds" at the provider is not necessarily the
 * change that was authorized. SCQ separates two different bad
 * outcomes, and this scenario produces both:
 *
 *   Part 1 — VIOLATED: the landed state is independently established
 *   and attributable to this operation, and it disagrees with the
 *   authorized quote. The operation did the wrong thing, provably.
 *
 *   Part 2 — UNVERIFIED: a third-party change lands inside the
 *   commit's validate -> dispatch window, so the operation executed
 *   on a state the quote never validated. The recorded immediate
 *   figure then nets the authorized change against the third party's
 *   effect and cannot be attributed to this operation: it is kept
 *   only as a candidate (determinacy UNKNOWN), and the receipt caps
 *   at COMMITTED_UNVERIFIED.
 *
 * The distinction matters: VIOLATED is evidence you can act on (the
 * obligation is established and wrong); UNVERIFIED is the absence of
 * attribution (you cannot tell whose effect the figure is). Treating
 * an unattributable figure as an established actual — or an
 * established violation as mere uncertainty — are both errors.
 */
import { ChargebeeAdapter, ChargebeeSim, QuoteStore } from "@agorail-labs/scq-reference";

const START = new Date("2026-08-01T00:00:00.000Z");
const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

function fixture(id) {
  const sub = {
    id,
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  };
  const sim = new ChargebeeSim(new Date(START));
  sim.seedSubscription(structuredClone(sub));
  return { sim, sub, adapter: new ChargebeeAdapter(sim, new QuoteStore()) };
}

const quote120 = (adapter, sub) =>
  adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

// ------------------------------------------------------------------
// Part 1 — VIOLATED: the mutation lands the WRONG quantity (130
// instead of the authorized 120). The evidence is operation-bound,
// so the wrong figure is established — DETERMINED — and the
// reconciliation is VIOLATED, not merely unverified.
// ------------------------------------------------------------------
{
  const { sim, sub, adapter } = fixture("cb_quickstart_b1");
  const quote = await quote120(adapter, sub);
  sim._debugWrongQuantityOnNextUpdate = 130; // simulator fault injection
  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log("Part 1 receipt status:", receipt.status);
  console.log("Part 1 reconciliation:", receipt.reconciliation.status);
  console.log("Part 1 committed determinacy:", JSON.stringify(receipt.committedEffect?.determinacy));
  console.log("Part 1 landed quantity:", receipt.resultingSnapshot?.items?.[0]?.quantity);
  console.log(
    "Part 1 reading: the landed effect is established AND attributable, and it is not what was authorized -> VIOLATED.",
  );
  if (receipt.reconciliation.status !== "VIOLATED") {
    console.error("Unexpected outcome for scenario B part 1: expected VIOLATED.");
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Part 2 — UNVERIFIED: a third-party item addition lands after this
// commit validated the subscription state but before its mutation
// executes. The dispatch (a full item replacement) deletes the
// addition, and the operation's priced figure (12500) nets the
// authorized +20000 against -7500 for deleting the third party's
// item. Because the operation did not begin on the validated state,
// that figure is not this commit's established actual: it is
// recorded as a candidate under UNKNOWN determinacy.
// ------------------------------------------------------------------
{
  const { sim, sub, adapter } = fixture("cb_quickstart_b2");
  const quote = await quote120(adapter, sub);

  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = (...args) => {
    sim._debugMutateDirectly(sub.id, (s) => {
      s.subscriptionItems.push({ id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 5 });
    });
    return realUpdate(...args);
  };

  const receipt = await adapter.commitChangeQuote(quote.id);
  console.log("Part 2 receipt status:", receipt.status);
  console.log("Part 2 reconciliation:", receipt.reconciliation.status);
  console.log("Part 2 recorded immediate net (minor units):", receipt.committedEffect?.immediate?.net);
  console.log("Part 2 committed determinacy:", JSON.stringify(receipt.committedEffect?.determinacy));
  console.log("Part 2 committed source:", receipt.committedEffect?.provenance?.committedSource);
  console.log(
    "Part 2 reading: the figure is retained as a candidate only — attribution failed, so nothing about it is established -> UNVERIFIED.",
  );
  if (
    receipt.reconciliation.status !== "UNVERIFIED" ||
    receipt.committedEffect?.determinacy?.immediateFinancialEffect !== "UNKNOWN"
  ) {
    console.error("Unexpected outcome for scenario B part 2: expected UNVERIFIED with UNKNOWN immediate.");
    process.exit(1);
  }
}

console.log("Scenario B complete: VIOLATED (established, wrong) is not UNVERIFIED (unattributable).");
