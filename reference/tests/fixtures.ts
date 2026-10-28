import { StripeSim, type StripeSubscription } from "../src/adapters/stripe-sim.js";
import { PaddleSim, type PaddleSubscription } from "../src/adapters/paddle-sim.js";
import { ZuoraSim, type ZuoraSubscription } from "../src/adapters/zuora-sim.js";
import { ChargebeeSim, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";

export function freshStripeFixture(): { sim: StripeSim; sub: StripeSubscription } {
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  const periodStart = nowSec;
  const periodEnd = nowSec + 30 * 24 * 3600; // 30-day period
  const sim = new StripeSim(nowSec);
  const sub: StripeSubscription = {
    id: "sub_test1",
    status: "active",
    items: [
      {
        id: "si_1",
        price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" },
        quantity: 100,
      },
    ],
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end: false,
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

export function freshPaddleFixture(): { sim: PaddleSim; sub: PaddleSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const sim = new PaddleSim(now);
  const sub: PaddleSubscription = {
    id: "sub_paddle_test1",
    status: "active",
    items: [{ price: { id: "pri_seat_basic", unitAmount: 1000, currencyCode: "USD", interval: "month" }, quantity: 100 }],
    currencyCode: "USD",
    billingCycle: { interval: "month", frequency: 1 },
    currentBillingPeriod: { startsAt: now.toISOString(), endsAt: periodEnd.toISOString() },
    nextBilledAt: periodEnd.toISOString(),
    scheduledChange: null,
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Evergreen (auto-renewing, no fixed committed term) Zuora subscription — the common, simplest case. */
export function freshZuoraFixture(): { sim: ZuoraSim; sub: ZuoraSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const sim = new ZuoraSim(now);
  const sub: ZuoraSubscription = {
    id: "A-S00000001",
    version: 1,
    status: "Active",
    ratePlans: [
      {
        id: "rp_1",
        productRatePlanId: "ratePlan_seat_basic_monthly",
        ratePlanCharges: [
          {
            id: "rpc_1",
            productRatePlanChargeId: "ratePlan_seat_basic_monthly",
            chargeModel: "PerUnit",
            unitAmount: 1000,
            currency: "usd",
            billingPeriod: "Month",
            quantity: 100,
          },
        ],
      },
    ],
    term: {
      initialTerm: 1,
      initialTermPeriodType: "Month",
      autoRenew: true,
      renewalTerm: 1,
      renewalTermPeriodType: "Month",
      contractEffectiveDate: now.toISOString().slice(0, 10),
      termStartDate: now.toISOString().slice(0, 10),
      termEndDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    },
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Evergreen (no contract_term) Chargebee subscription — the common, simplest case. */
export function freshChargebeeFixture(): { sim: ChargebeeSim; sub: ChargebeeSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const termEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const sim = new ChargebeeSim(now);
  const sub: ChargebeeSubscription = {
    id: "cb_test1",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: now.toISOString(),
    currentTermEnd: termEnd.toISOString(),
    nextBillingAt: termEnd.toISOString(),
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Chargebee subscription under a fixed 12-month contract_term (not evergreen) — for contract-heavy test scenarios. */
export function freshChargebeeCommittedTermFixture(): { sim: ChargebeeSim; sub: ChargebeeSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const contractStart = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
  const contractEnd = new Date(now.getTime() + 300 * 24 * 3600 * 1000); // ~10 months remaining of a 12-month term
  const termEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const sim = new ChargebeeSim(now);
  const sub: ChargebeeSubscription = {
    id: "cb_test2",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: now.toISOString(),
    currentTermEnd: termEnd.toISOString(),
    nextBillingAt: termEnd.toISOString(),
    contractTerm: {
      contractStart: contractStart.toISOString().slice(0, 10),
      contractEnd: contractEnd.toISOString().slice(0, 10),
      actionAtTermEnd: "renew",
    },
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Zuora subscription under a fixed 12-month COMMITTED term (not evergreen) — for contract-heavy test scenarios. */
export function freshZuoraCommittedTermFixture(): { sim: ZuoraSim; sub: ZuoraSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const sim = new ZuoraSim(now);
  const termEnd = new Date(now.getTime() + 300 * 24 * 3600 * 1000); // ~10 months remaining of a 12-month term
  const sub: ZuoraSubscription = {
    id: "A-S00000002",
    version: 1,
    status: "Active",
    ratePlans: [
      {
        id: "rp_1",
        productRatePlanId: "ratePlan_seat_basic_monthly",
        ratePlanCharges: [
          {
            id: "rpc_1",
            productRatePlanChargeId: "ratePlan_seat_basic_monthly",
            chargeModel: "PerUnit",
            unitAmount: 1000,
            currency: "usd",
            billingPeriod: "Month",
            quantity: 100,
          },
        ],
      },
    ],
    term: {
      initialTerm: 12,
      initialTermPeriodType: "Month",
      autoRenew: false,
      renewalTerm: 12,
      renewalTermPeriodType: "Month",
      contractEffectiveDate: new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      termStartDate: new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      termEndDate: termEnd.toISOString().slice(0, 10),
    },
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}
