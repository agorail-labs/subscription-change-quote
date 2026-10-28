# SCQ v0.6.1 — Provider-Neutral Examples

These examples are schematic. Amounts are minor currency units. They illustrate SCQ semantics rather than any one provider's wire format.

## 1. Increase quantity: 100 -> 120 seats

### Proposal

```json
{
  "changes": [
    {"action": "CHANGE_QUANTITY", "itemId": "seats", "quantity": 120}
  ],
  "effectiveIntent": {"type": "IMMEDIATE"},
  "guaranteeMode": "REVALIDATE",
  "acceptanceEnvelope": {
    "maxImmediateNetIncrease": 5000,
    "maxRecurringIncrease": 4000
  }
}
```

### Quote

```json
{
  "id": "quote_001",
  "guaranteeMode": "REVALIDATE",
  "guaranteeCoverage": {
    "immediateFinancialEffect": "REVALIDATE",
    "recurringFinancialEffect": "REVALIDATE",
    "termEffect": "UNKNOWN",
    "effectiveAt": "EXACT"
  },
  "multiChangeConsistency": "ATOMIC",
  "commercialEffect": {
    "immediate": {"net": 20000},
    "recurring": {"resultingAmount": 216000, "currency": "usd"},
    "effectiveAt": "2026-09-01T00:00:00Z"
  },
  "validUntil": "2026-09-01T00:05:00Z"
}
```

The quote is $200 due now and $2,160 resulting recurring amount. The envelope permits the last pre-mutation preview to worsen by at most $50 immediately and $40 recurring, producing effective ceilings of $250 and $2,200 for this quote.

### Successful commit

Suppose the last preview becomes $215 due now and $2,170 recurring. It remains inside the envelope.

```json
{
  "quoteId": "quote_001",
  "status": "COMMITTED",
  "quotedEffect": {
    "immediate": {"net": 20000},
    "recurring": {"resultingAmount": 216000, "currency": "usd"}
  },
  "committedEffect": {
    "immediate": {"net": 21500},
    "recurring": {"resultingAmount": 217000, "currency": "usd"}
  },
  "guaranteeMode": "REVALIDATE",
  "consistencyGuarantee": "BEST_EFFORT",
  "multiChangeConsistency": "ATOMIC",
  "reconciliation": {"status": "OK"}
}
```

## 2. Change plan

```json
{
  "changes": [
    {"action": "CHANGE_PLAN", "itemId": "base", "offeringRef": "pro-v2"}
  ],
  "effectiveIntent": {"type": "TERM_END"},
  "guaranteeMode": "REVALIDATE",
  "acceptanceEnvelope": {
    "maxImmediateNetIncrease": 0,
    "maxRecurringIncrease": 10000
  }
}
```

A provider that supports term-end plan changes may quote no immediate charge, a new recurring amount at the next term boundary, and `termEffect: "UNKNOWN"` if the provider cannot deterministically expose contractual consequences. SCQ does not invent a commitment answer merely because it can calculate the new price.

If the provider does not support `TERM_END` for `CHANGE_PLAN`, the proposal is refused before preview/mutation with `UNSUPPORTED_CHANGE` rather than silently applying immediately.

## 3. Change cadence

```json
{
  "changes": [
    {"action": "CHANGE_CADENCE", "cadence": "ANNUAL"}
  ],
  "effectiveIntent": {"type": "DATE", "at": "2026-10-01T00:00:00Z"},
  "guaranteeMode": "REVALIDATE",
  "acceptanceEnvelope": {
    "maxImmediateNetIncrease": 0,
    "maxRecurringIncrease": 0
  }
}
```

A quote can say that the financial and effective-date dimensions are exact while the contract-term dimension is unknown. Because overall `EXACT` requires every modeled dimension to be exact, such a proposal must use `REVALIDATE` or be refused if the caller requests overall `EXACT`.

## 4. Cancel at term end

For a subscription where the cancellation consequence is fully knowable:

```json
{
  "changes": [{"action": "CANCEL"}],
  "effectiveIntent": {"type": "TERM_END"},
  "guaranteeMode": "EXACT"
}
```

A CANCEL-only proposal does not require a financial acceptance envelope under the current SCQ model. A successful quote/receipt can state that auto-renewal is disabled and cancellation occurs at the provider-defined term boundary.

For a committed-term subscription where the adapter cannot determine early-termination or commitment consequences, `termEffect` must be `UNKNOWN`; an overall `EXACT` request must therefore be refused.

---

# Failure examples

## `QUOTE_DRIFTED`

Quote:

```text
Immediate net: $200
Recurring:     $2,160
Envelope:      +$50 immediate, +$40 recurring
```

Last pre-mutation preview:

```text
Immediate net: $275
Recurring:     $2,160
```

The immediate effect worsened by $75, exceeding the allowed $50 drift.

```json
{
  "code": "QUOTE_DRIFTED",
  "message": "Revalidated commercial effect exceeds the acceptance envelope"
}
```

No mutation occurs.

## `UNSUPPORTED_CHANGE_SET`

This is a defensive protocol-level example. If an adapter discovers that a provider might accept a bundled request but silently apply only a subset, it must refuse before mutation:

```json
{
  "changes": [
    {"action": "CHANGE_QUANTITY", "itemId": "seats", "quantity": 120},
    {"action": "CANCEL"}
  ],
  "effectiveIntent": {"type": "IMMEDIATE"}
}
```

```json
{
  "code": "UNSUPPORTED_CHANGE_SET",
  "message": "Provider execution may silently apply only part of this change set"
}
```

The caller must split or abandon the operation; SCQ does not deliberately submit an ambiguous partial-application request.

## Reconciliation `VIOLATED`

Under `BEST_EFFORT`, the last preview can be inside the envelope and a concurrent write can still land before the provider mutation completes.

Example:

```text
Quoted immediate:          $200
Pre-mutation revalidation: $220  (allowed)
Actual committed effect:   $290  (outside envelope)
```

The mutation has already occurred, so v0.6.1 reports rather than rewinds:

```json
{
  "status": "COMMITTED",
  "guaranteeMode": "REVALIDATE",
  "consistencyGuarantee": "BEST_EFFORT",
  "committedEffect": {"immediate": {"net": 29000}},
  "reconciliation": {
    "status": "VIOLATED",
    "reason": "Committed immediate effect exceeded the accepted drift envelope"
  }
}
```

A production caller should treat this as a high-priority reconciliation event. SCQ does not claim automatic rollback.
