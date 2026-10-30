# Chargebee Capability Assessment — SCQ Issue 22

**Scope:** Documentation research only. No code was changed for this assessment.
**Date of research:** 2026-10-30
**Sources:** Official Chargebee documentation only — pages on `www.chargebee.com/docs`,
`apidocs.chargebee.com`, `apidocs.eu.chargebee.com`, and `api-static-site.chargebee.com`
(the regional / static mirrors of the same official API documentation), each fetched
in full on 2026-10-30. Every factual claim below cites the exact URL it came from.
Short quoted phrases are Chargebee's own wording. Anything that is reasoning from
the documented surface — rather than a documented statement — is labelled
**Assessment**.

**Problem restated (from the task, not from Chargebee docs):** SCQ's Chargebee adapter
commits via `update_for_items` with `replace_items_list=true` and the full intended
item list, built from an earlier snapshot. A concurrent third-party addition landing
between SCQ's final pre-commit read and the dispatch is silently deleted by the
full-list replacement, and SCQ's post-commit target-state verification passes
because the resulting state matches SCQ's intended list.

## Sources checked

| # | URL |
|---|---|
| S1 | https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items |
| S2 | https://apidocs.chargebee.com/docs/api/subscriptions?prod_cat_ver=2&lang=curl |
| S3 | https://apidocs.chargebee.com/docs/api/idempotency?prod_cat_ver=2 |
| S4 | https://apidocs.chargebee.com/docs/api/events |
| S5 | https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20 |
| S6 | https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps |
| S7 | https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp |
| S8 | https://api-static-site.chargebee.com/docs/api/ramps |
| S9 | https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl |
| S10 | https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items |
| S11 | https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription |
| S12 | https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-to-update-a-subscription |
| S13 | https://www.chargebee.com/docs/billing/2.0/integrations/salesforce-integration-guide |

Search terms also run against the official documentation (no matching official page
found in the results for the CAS question): "ETag If-Match optimistic concurrency
resource_version precondition", "Chargebee API headers ETag resource_version update
precondition". Non-official results returned by those searches (blogs, third-party
wikis) were **not** used as evidence.

---

## 1. `update_for_items` semantics — `replace_items_list`, `mandatory_items_to_remove`

### 1.1 The concise definition (repeated across endpoints)

The quote, estimate, and hosted-page variants of the same operation all define it
identically:

> "If `true` then the existing `subscription_items` list for the subscription is
> replaced by the one provided. If `false` then the provided `subscription_items`
> list gets added to the existing list."
> — https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items

The same sentence appears at:

- https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription
- https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-to-update-a-subscription

`replace_items_list` is "optional, boolean, default=false" in all three.

### 1.2 The fuller definition on the update endpoint itself

The Update a subscription (for items) page gives a case-split definition that the
one-sentence version omits. It says the parameter:

> "Determines whether the provided `subscription_items` replace existing
> subscription items or are added to the existing list."

**When `subscription_items` includes a plan:**

- "`true`: The entire subscription item list (plan and addons) is replaced by the
  provided list."
- "`false`: The provided items are added to the existing list. If multi-plan
  subscriptions is disabled, the existing plan item price is replaced. If
  multi-plan subscriptions is enabled, the existing plan item price is retained."

**When `subscription_items` contains only addons:**

- "The existing plan on the subscription is always retained; it is not replaced."
- "`true`: Existing addons are replaced by the provided addons, except mandatory
  addons (auto-attached to the plan). Mandatory addons are kept unless you list
  them in `mandatory_items_to_remove`. The subscription will have the current
  plan, the addons you passed, plus any existing mandatory addons not in
  `mandatory_items_to_remove`."
- "`false`: The provided addons are added to the existing addons."

— https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items

**Consequence for SCQ's current usage (Assessment, following directly from the
quoted text):** with a plan in the list and `replace_items_list=true`, the operation
is defined as replacement of the *entire* list by the provided list. An item present
on the subscription at dispatch time but absent from the provided list is therefore
removed by definition of the operation — it is not an edge case in the documented
semantics.

### 1.3 Removing individual addons — the documented recipe requires `true`

Chargebee's own knowledge-base article states the only documented API recipe for
removing one addon is full-list replacement with the retained set:

> "If a subscription has 2 or more addons, and if you want to remove one addon,
> then you need to pass replace_items_list=true and pass addon item price id as
> subscription_items[item_price_id][1] which needs to be retained."
> "If replace_items_list=false and if any subscription items are passed, then it
> adds the addon."
> "When we set "replace_items_list" to true, and do not pass any other parameter,
> it ideally removes all the addons attached to the plan."

— https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20

### 1.4 `mandatory_items_to_remove` — what it is

On the update endpoint:

> "`mandatory_items_to_remove` — optional, string, max chars=100 — A list of item
> IDs representing the mandatorily attached addons associated with the plan to
> which the subscription is being updated. These addons will be removed from the
> subscription during the subscription update process."
> — https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items

The parameter is listed (without that explanatory text) on the quote, estimate, and
hosted-page variants as well:

- https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items
- https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription
- https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-to-update-a-subscription

### 1.5 Are mandatory addons preserved under replacement?

Yes, by default, in the addons-only case documented at §1.2: mandatory addons are
kept under `replace_items_list=true` unless listed in `mandatory_items_to_remove`.
The knowledge-base article summarises the same rule for the bulk-operation form of
the same call:

> "The existing plan and any mandatory addons are always preserved. Mandatory
> addons are removed only if explicitly listed under `mandatory_items_to_remove`."
> — https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20

Note the documented scope carefully: the explicit mandatory-addon exception is
stated for the case where `subscription_items` contains only addons. For the
plan-included case, the API reference says only "The entire subscription item list
(plan and addons) is replaced by the provided list" and does not repeat the
mandatory exception in that bullet (S1). Whether the mandatory exception also
applies inside a plan-included full replacement is **not separately stated** in the
sources checked — see UNVERIFIED at the end.

### 1.6 Other parameters governing the item list

In the full parameter list fetched from S1, the parameters that govern the item
list itself are:

- `subscription_items[0..n]` — the item list being supplied (each entry carries,
  among other fields, `item_price_id` and `quantity`).
- `replace_items_list` — replace-vs-add switch (§1.1–1.2).
- `mandatory_items_to_remove` — the sole documented exception carve-out for
  mandatorily attached addons (§1.4).

The analogous switch for coupons, `replace_coupon_list` ("Should be true if the
existing coupons should be replaced with the ones that are being passed", S10),
governs coupons only, not items. No other item-list-governing parameter appears in
the fetched parameter list of S1.

**Evidence classification: DOCUMENTATION_SUPPORTED** —
https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items ;
https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items ;
https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20

---

## 2. Atomic conditional write — compare-and-swap / optimistic-concurrency precondition

### 2.1 What was looked for

Any of: `resource_version` accepted as a **write input** / precondition on
`update_for_items` or any subscription update endpoint; an ETag / `If-Match` (or
`If-Unmodified-Since`) header honoured on writes; or any parameter of the form
"update only if unchanged since version/timestamp X".

### 2.2 Findings

- The full fetched input-parameter list of the Update a subscription (for items)
  endpoint (S1) contains **no** `resource_version` input, no version/precondition
  parameter of any name, and no mention of ETag or `If-Match`. A text search of the
  fetched page for `resource_version`, `ETag`, and `If-Match` returned no matches.
- On the Subscriptions resource page (S2), `resource_version` appears only as an
  **output attribute** of the subscription resource (see §5) — not as an input
  parameter to any operation documented on that page.
- The Idempotency page (S3), which is the official page that documents Chargebee's
  special request headers (`chargebee-idempotency-key`,
  `chargebee-idempotency-replayed`), documents no conditional-write header.
- The searches listed under "Sources checked" for ETag / If-Match / optimistic
  concurrency returned no Chargebee official documentation page describing such a
  mechanism; the hits were third-party, non-Chargebee pages and were not used.

### 2.3 Related, but not a compare-and-swap: `lock_timeout`

One concurrency-adjacent behaviour **is** documented, in the error catalogue:

> "`lock_timeout` | Returned when there are multiple concurrent requests to the
> same resource. **HTTP Code:** 429, **Sample message:** The request cannot be
> processed right now as another API request or process is currently accessing
> the same resource. Please retry."
> — https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl

**Assessment:** as documented, this is a simultaneous-access lock with a
"please retry" outcome. It is not keyed to any client-supplied version or to the
state the client read, and the documented remedy (retry the same request) does not
re-validate the payload against current state. It therefore does not, on its
documented description, cover the SCQ window, in which the third-party change has
already **completed** before SCQ's dispatch begins — at dispatch time there is no
longer a concurrent request to lock against. This assessment is reasoning from the
documented description, not a Chargebee statement about SCQ's scenario.

**Evidence classification: NOT DOCUMENTED IN SOURCES CHECKED** for a
compare-and-swap / optimistic-concurrency write precondition (no `resource_version`
write precondition, no ETag/`If-Match`, no "update only if unchanged since"
parameter), in the sources checked:
https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items ;
https://apidocs.chargebee.com/docs/api/subscriptions?prod_cat_ver=2&lang=curl ;
https://apidocs.chargebee.com/docs/api/idempotency?prod_cat_ver=2 ;
https://apidocs.chargebee.com/docs/api/events ;
https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl ;
https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items ;
https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription

The narrower `lock_timeout` behaviour itself is **DOCUMENTATION_SUPPORTED** —
https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl

---

## 3. Targeted / partial updates — changing one item without resubmitting the whole list

### 3.1 What `replace_items_list=false` does and does not do

Documented (S1, §1.2 above):

- Addons-only, `false`: "The provided addons are added to the existing addons."
- Plan-included, `false`: "The provided items are added to the existing list",
  with the plan nuance that, if multi-plan subscriptions is disabled, "the
  existing plan item price is replaced" (if enabled, it is retained).

So an **additive** single-item change — adding one new addon/charge, or (in the
multi-plan-disabled case) swapping the plan item price — can be expressed without
resubmitting the whole list, and such a call by its documented definition does not
remove items it does not mention.

### 3.2 Removal with `false`

Not documented — and the documented recipe points the other way. The official KB
article (§1.3) instructs that to remove one addon you "need to" use
`replace_items_list=true` and pass the addons to be **retained**; it describes
`false` only as adding: "If replace_items_list=false and if any subscription items
are passed, then it adds the addon."
— https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20

No `items_to_remove`-style parameter exists on `update_for_items` in the fetched
parameter list (S1). (An `items_to_remove` list does exist on **Ramps** — see §6 —
but that is a future-scheduled change, not this endpoint.)

### 3.3 Quantity change with `false`

`subscription_items` entries carry a `quantity` field, and the endpoint can in
general be used to set quantities. However, **no statement was found in the sources
checked** describing what happens when, with `replace_items_list=false`, the caller
passes an `item_price_id` that is **already on the subscription** with a different
`quantity` — i.e. whether that updates the existing item in place, adds a second
line, or is rejected. The documented text for `false` says only that the provided
items "are added to the existing list" / "are added to the existing addons" (S1).
Treat in-place quantity update via `false` as **not documented in the sources
checked**, not as established behaviour.

### 3.4 Other partial-update surface on the same endpoint

The operation's general description is partial at the *parameter* level:

> "Updates a subscription by modifying its item prices, coupons, billing
> configuration, payment method, and other attributes. Any parameters not
> provided remain unchanged."
> — https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items

That partiality applies to the non-item parameters. It does not change the
item-list semantics in §1: item removal is still governed by `replace_items_list`.

**Evidence classification:**
- Additive single-item change with `replace_items_list=false`, and the plan-swap
  nuance: **DOCUMENTATION_SUPPORTED** —
  https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items
- Removal of an item with `replace_items_list=false`: **NOT DOCUMENTED IN SOURCES
  CHECKED**; the documented removal recipe requires `true` —
  https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20
- In-place quantity change of an already-present item via `false`:
  **NOT DOCUMENTED IN SOURCES CHECKED** (list in §2.2 / Sources checked).

---

## 4. Idempotency — `chargebee-idempotency-key`

All statements in §4.1 are from the official Idempotent requests page:
https://apidocs.chargebee.com/docs/api/idempotency?prod_cat_ver=2

### 4.1 Documented semantics

- Mechanism: "provide the `chargebee-idempotency-key` header with a unique value
  for each request. When you send a POST request with the idempotency key,
  Chargebee checks for an existing record for that key. If there is a record,
  Chargebee returns the response for that record with a response header
  `chargebee-idempotency-replayed` set to `true` … instead of processing the
  request again. If there is no existing record for the idempotency key, Chargebee
  creates a new record for the request."
- Purpose as documented: it "enables safe and reliable retrying of requests,
  without accidentally duplicating or repeating the same operation twice"; "This
  helps the server make sure that it doesn't process the same request twice."
- Key format: "We recommend using the "UUID" RFC4122 or a similar random identifier
  as an idempotency key." "Idempotency keys can be up to **100** characters in
  length. Estimate APIs do not support Idempotency."
- **Window:** "Chargebee has an idempotency window of **30 minutes**, during which
  time any requests with the same idempotency key and parameters will be
  considered as a replay of the original request."
- **Same key, different parameters — 422:** the error table states 422
  Unprocessable Entity "occurs when retrying a request with different parameters
  than the original request", because Chargebee verifies "the incoming **`retry`**
  request signature by comparing the `URI path, request body and headers` with
  the original request", and throws the error if they do not match. The error
  catalogue names the corresponding code `unable_to_process_request`: "this error
  is returned when a client attempts to reuse an idempotency key with a different
  request payload. **HTTP Code:** 422"
  — https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl
- **Concurrent duplicate — 409:** "This indicates that the requested operation
  cannot be completed at this time due to a conflict with another request that is
  currently being processed. Additionally, a `retry-after` header will be included
  in the response…"
- **Errors:** 400 if the key header is empty or exceeds 100 characters. 5xx errors
  "are cached", so a retry within the window returns the same response; to process
  anyway, send "the same request using a new `chargebee-idempotency-key`".
- GET requests: "GET requests are inherently idempotent… Adding an idempotency key
  along with the GET request is redundant."

### 4.2 Why idempotency is NOT a compare-and-swap (Assessment)

This subsection is reasoning from the documented semantics in §4.1, stated
explicitly as required:

1. The key identifies **a request**, not a resource state. Replay matching is
   defined over "the same idempotency key and parameters" and over the retry's
   "URI path, request body and headers" versus the original request. Nothing in
   the documented comparison involves the subscription's current state or its
   `resource_version`.
2. A replay **returns the stored original response** "instead of processing the
   request again" — it neither re-reads nor re-validates the target resource.
3. A *different* writer using a *different* key (the SCQ scenario's third party)
   is an ordinary new request to Chargebee; the idempotency machinery has no
   documented interaction with it, and SCQ's own dispatch — first use of its key —
   is processed normally against whatever state exists at that moment, including
   applying the full-list replacement.
4. Therefore idempotency protects against **duplicate processing of SCQ's own
   request** (e.g. a network retry re-dispatching the same full-list payload); it
   does not detect, and cannot reject, a write whose *basis* (the earlier snapshot)
   has gone stale because someone else changed the resource in between.

**Evidence classification: DOCUMENTATION_SUPPORTED** for the semantics in §4.1 —
https://apidocs.chargebee.com/docs/api/idempotency?prod_cat_ver=2 ;
https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl .
§4.2 is labelled Assessment (deduction from those documented semantics), not a
Chargebee claim.

---

## 5. `resource_version` — what it is, and what it is documented FOR

### 5.1 Definition

On the Subscription resource:

> "`resource_version` — optional, long — Version number of this resource. The
> `resource_version` is updated with a new timestamp in milliseconds for every
> change made to the resource. This attribute will be present only if the resource
> has been updated after 2016-09-28."
> — https://apidocs.chargebee.com/docs/api/subscriptions?prod_cat_ver=2&lang=curl

So, as documented, it is **not** a sequential counter (1, 2, 3…): its new value on
each change is "a new timestamp in milliseconds". The same definition wording
appears on other resources checked, including Ramps:
https://api-static-site.chargebee.com/docs/api/ramps

The docs do not, in the sources checked, use the word "monotonic" for it or state a
monotonicity guarantee. A `>` comparison is, however, the documented usage pattern
in the one place the docs prescribe a use for it (§5.2).

### 5.2 Documented purpose: ordering webhook events / syncing changes

The Events page, under "Out-of-order Delivery":

> "Webhooks can also arrive at your application out-of-order. … However, you can
> order the events by examining the `resource_version` attribute of the resource
> sent by the webhook. For every change made to the resource, `resource_version`
> is updated with a new timestamp in milliseconds."
> "For example, if you wish to sync resource changes from Chargebee to your
> application, you can: 1. Get the value `rv1` of the `resource_version` attribute
> from the resource in the webhook. 2. Get the value `rv2` of `resource_version`
> from the resource stored on your side. 3. If `rv1` > `rv2`, process the
> resource; otherwise, ignore."
> — https://apidocs.chargebee.com/docs/api/events

That — change-detection / ordering on the **receiving** side — is the documented
purpose found in the sources checked. In those sources, `resource_version` is
documented only as an output attribute; it is not documented as a write input or
precondition anywhere (see §2).

**Assessment (consequence for SCQ):** because it changes on every change, a
post-commit re-read *can* use `resource_version` to know the resource changed at
some point; but since SCQ's own commit also changes it, and a target-state check
compares item state rather than intervening history, a changed `resource_version`
alone does not by itself distinguish "my change only" from "a third-party change
landed and was then overwritten". That is reasoning about SCQ's verification
design, not a Chargebee documentation claim.

**Evidence classification: DOCUMENTATION_SUPPORTED** —
https://apidocs.chargebee.com/docs/api/subscriptions?prod_cat_ver=2&lang=curl ;
https://apidocs.chargebee.com/docs/api/events

---

## 6. Ramps

### 6.1 What the docs say they are

> "Subscription Ramps let you schedule future subscription pricing changes."
> "Subscription Ramps let you schedule the following changes to a subscription:
> Changing the plan. Adding, removing, or updating addons and charges. Applying or
> removing discounts and coupons. Adjusting prices for plans, addons, and
> charges."
> — https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps

> "A `ramp` resource, or subscription ramp, represents a planned change to a
> `subscription` that occurs at a future date. Use this resource to define and
> schedule subscription modifications, such as updating pricing, altering
> quantity, or transitioning to a different plan, without immediately applying
> them."
> — https://api-static-site.chargebee.com/docs/api/ramps

### 6.2 Availability — early access

> "Subscription Ramps is in early access. Request access, if it isn't enabled on
> your Chargebee Billing site."
> — https://api-static-site.chargebee.com/docs/api/ramps

Corroborated in the product docs: "Ramps is currently in the Chargebee EAP
Program, please reach out to eap@chargebee.com to have this enabled on your
Chargebee site…"
— https://www.chargebee.com/docs/billing/2.0/integrations/salesforce-integration-guide

This matches SCQ's adapter position (Ramps treated as early-access / not
implemented); the docs give no basis to change that position.

### 6.3 Targeted change lists — but future-dated

The Create a ramp API is the one place in the sources checked with genuinely
targeted item parameters:

- `items_to_add[0..n]`, `items_to_update[0..n]`, and `items_to_remove` ("List of
  item prices removed from the subscription through this ramp"), plus
  `coupons_to_remove` and `discounts_to_remove`.
  — https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp

But a ramp is inherently future-scheduled:

- `effective_from` is **required**, is "The time when this ramp takes effect", and
  "`effective_from` must not be in the past." There must be "a minimum 24-hour
  interval between `effective_from` of two consecutive ramps", and the time must
  be within five years.
  — https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp
- Limits: "A subscription can have a maximum of 12 upcoming ramps at any given
  time" and "a maximum of 100 ramps" in total.
  — https://api-static-site.chargebee.com/docs/api/ramps
- "Subscription Ramps do not include support for estimates."
  — https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps
- The older scheduling parameters on the update endpoint are deprecated in favour
  of ramps: for `end_of_term`, "This option is deprecated; use the Create a ramp
  API instead", and likewise setting `changes_scheduled_at` to a future date-time
  "for scheduling changes is deprecated. Use the Create a ramp API instead."
  — https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items

The fetched Create a ramp parameter list (S7) contains no version/precondition
parameter either.

### 6.4 Do Ramps change the SCQ picture?

**Assessment:** No, for the immediate-commit race in question. A ramp expresses a
targeted add/update/remove set, which avoids restating the whole list, but it
applies at a future `effective_from` (not in the past; ≥24h spacing between
consecutive ramps), is early-access, and has no documented compare-and-swap
precondition, so a third-party change landing between ramp creation and ramp
execution is not addressed by any mechanism documented in the sources checked.
Ramps could be relevant to a future redesign of *scheduled* SCQ changes; they are
not a documented fix for the immediate validate→dispatch window.

**Evidence classification: DOCUMENTATION_SUPPORTED** for §§6.1–6.3 —
https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps ;
https://api-static-site.chargebee.com/docs/api/ramps ;
https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp ;
https://www.chargebee.com/docs/billing/2.0/integrations/salesforce-integration-guide .
§6.4 is labelled Assessment.

---

## 7. The validate→dispatch window — does any documented mechanism close it?

The window: SCQ reads/validates state → (third-party change lands) → SCQ dispatches
`update_for_items` with `replace_items_list=true` and the full intended list →
documented semantics (§1.2) replace the entire list with the provided one, deleting
the third-party addition → post-commit state equals SCQ's intended list, so a
target-state verification passes.

Checking each candidate mechanism against the documented surface:

| Candidate | Closes the window? (per sources checked) | Why |
|---|---|---|
| CAS / optimistic-concurrency precondition (`resource_version`, ETag/`If-Match`, "unchanged since") | Not documented in sources checked | §2 — no such input on the endpoint; `resource_version` is output-only in the docs |
| Idempotency key | No | §4 — deduplicates SCQ's own retries; keyed to the request, not to resource state |
| `lock_timeout` (429) | No, on its documented description | §2.3 — simultaneous-access lock + "please retry"; the third-party change has already completed before dispatch |
| `replace_items_list=false` (additive mode) | Partially, by avoidance — not a guard | A purely additive SCQ change expressed with `false` does not, by definition, delete unmentioned items (§3.1). But documented **removal** requires `true` + retained list (§3.2), and in-place quantity change via `false` is not documented (§3.3) — so any SCQ change set containing a removal cannot be expressed in `false` mode on the documented surface |
| `mandatory_items_to_remove` | No | Carve-out for mandatorily attached addons only (§1.4–1.5); unrelated items are unaffected |
| Ramps (`items_to_add` / `items_to_update` / `items_to_remove`) | No, for immediate commits | §6 — future-dated (`effective_from` not in the past), early access, no documented precondition |
| Post-commit re-read / target-state verification | No (by construction of the scenario) | The resulting state *is* the intended list; the loss is of an item SCQ never intended to touch, which a target-state comparison does not flag. (Scenario premise, not a Chargebee claim.) |

**Explicit statement:** In the sources checked, **no documented Chargebee mechanism
closes the read→write race** for an immediate `update_for_items` commit that
includes a removal. A documented gap remains: the documented operation that
performs a removal (full-list replacement) has no documented precondition tying
the write to the state the caller read, and the documented partial mode cannot
express a removal. This is phrased as, and is only, "not documented in the sources
checked" — it is **not** a proof that no such mechanism exists anywhere in
Chargebee (e.g. in undocumented behaviour, support-enabled settings, newer doc
revisions, or other endpoints not checked).

**Sources checked for this section:** S1–S13 as listed under "Sources checked",
specifically
https://apidocs.eu.chargebee.com/docs/api/subscriptions/update-subscription-for-items ;
https://apidocs.chargebee.com/docs/api/subscriptions?prod_cat_ver=2&lang=curl ;
https://apidocs.chargebee.com/docs/api/idempotency?prod_cat_ver=2 ;
https://apidocs.chargebee.com/docs/api/events ;
https://apidocs.eu.chargebee.com/docs/api/v1/error-handling?lang=curl ;
https://www.chargebee.com/docs/billing/2.0/kb/product-catalog/how-to-remove-addons-from-a-subscription-via-api-in-pc-20 ;
https://apidocs.chargebee.com/docs/api/quotes/create-a-quote-for-update-subscription-items ;
https://apidocs.chargebee.com/docs/api/estimates/estimate-for-updating-a-subscription ;
https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-to-update-a-subscription ;
https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps ;
https://apidocs.chargebee.com/docs/api/ramps/create-a-ramp ;
https://api-static-site.chargebee.com/docs/api/ramps

**Evidence classification: NOT DOCUMENTED IN SOURCES CHECKED** (for a
race-closing mechanism), with the source list above.

---

## Summary table

| Capability | Documented? | Effect on the SCQ race | Key source |
|---|---|---|---|
| `replace_items_list=true`, plan included | Yes | **Causes it** — "The entire subscription item list (plan and addons) is replaced by the provided list" | S1 |
| `replace_items_list=true`, addons only | Yes | Replaces addons; plan retained; mandatory addons kept unless in `mandatory_items_to_remove` | S1 |
| `replace_items_list=false` | Yes | Additive only per docs; unmentioned items not removed | S1, S5 |
| Remove one addon | Yes, via `true` + retained list only | Forces the full-list pattern for any removal | S5 |
| `mandatory_items_to_remove` | Yes | Removes listed mandatorily attached addons; sole documented exception to mandatory preservation | S1 |
| CAS / optimistic concurrency (`resource_version` as write precondition, ETag/`If-Match`, "unchanged since") | **Not documented in sources checked** | — | S1, S2, S3, S9 |
| `lock_timeout` 429 on simultaneous access | Yes | Does not cover a change that completed before dispatch; documented remedy is retry | S9 |
| Idempotency (`chargebee-idempotency-key`) | Yes — 30-min window, replay returns stored response + `chargebee-idempotency-replayed: true`, same-key/different-params → 422, concurrent duplicate → 409 | Protects against duplicate processing of SCQ's own request; **not** a CAS (§4.2) | S3, S9 |
| `resource_version` | Yes — output attribute, "updated with a new timestamp in milliseconds for every change" | Documented FOR webhook out-of-order ordering / change sync; not a write precondition | S2, S4 |
| Targeted quantity change of an existing item via `false` | **Not documented in sources checked** | — | S1, S5 |
| Ramps | Yes — early access / EAP; `items_to_add` / `items_to_update` / `items_to_remove`; `effective_from` required, not in past, ≥24h spacing; ≤12 upcoming / ≤100 total; no estimates | Targeted but future-scheduled; no documented precondition; does not fix immediate commits | S6, S7, S8, S13 |

## What remains UNVERIFIED

Explicitly **not** established by this research:

1. **Absence anywhere.** "Not documented in sources checked" is not proof of
   non-existence. Undocumented API behaviour, support-enabled site settings,
   beta/EAP features beyond Ramps, partner/enterprise documentation, and doc
   revisions after 2026-10-30 were not checked and could change any negative
   finding above. Only the pages listed under "Sources checked" were read in full.
2. **Mandatory addons in a plan-included full replacement.** The API reference
   states the mandatory-addon exception explicitly only for the addons-only case
   (§1.5); its application inside a plan-included `replace_items_list=true` call
   is not separately stated in the sources checked.
3. **Quantity semantics under `false`.** Whether passing an already-present
   `item_price_id` with a new `quantity` and `replace_items_list=false` updates
   in place, duplicates, or errors is not documented in the sources checked (§3.3).
   This would need a test-site experiment or a Chargebee support answer.
4. **`lock_timeout` trigger boundaries.** The docs do not specify how long the
   concurrent-access lock is held, whether it serialises sequential (non-overlapping)
   requests, or any timing window (§2.3). No claim is made about its real timing
   behaviour beyond the quoted description.
5. **`resource_version` guarantees.** The docs describe it as a millisecond
   timestamp updated on every change and prescribe a `>` comparison for webhook
   ordering, but state no monotonicity, uniqueness, or clock-skew guarantee in the
   sources checked; two changes within the same millisecond are not addressed.
6. **Idempotency scope details.** Whether the idempotency record is scoped per
   endpoint, per site, or per API key, and exactly which headers enter the retry
   signature beyond "URI path, request body and headers", are not specified in the
   sources checked.
7. **Regional doc parity.** The fuller `replace_items_list` definition was fetched
   from the EU mirror (`apidocs.eu.chargebee.com`); the concise definition was
   verified on `apidocs.chargebee.com` (S10–S12). No claim is made that every
   regional mirror's wording is identical in every detail.
8. **No live behaviour was tested.** This assessment is documentation-only, per
   its scope: no Chargebee test-site call was made, so no documented claim here
   has been confirmed against a live (or test) Chargebee site for SCQ's account,
   product-catalog version, or enabled feature set.
