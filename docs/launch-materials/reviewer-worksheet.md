# Candidate-reviewer worksheet — Agorail external evaluation

**Status: planning worksheet. Nobody listed here has been contacted
about Agorail evaluation, and nobody here uses or endorses Agorail,
MSE, or SCQ.** Every entry is grounded in a documented public
interaction with the maintainer's prior open-source work (UCP, AP2,
or the SCQ repository). Details that could not be verified from the
public record are marked **to confirm** rather than asserted. Existing
technical relationships are considered before any cold outreach —
Fabio, who has already reviewed SCQ once, is listed first for that
reason.

| # | Name / public GitHub identity | Relevant expertise | Public project or contribution establishing relevance | Appropriate public contact channel | Reason for requesting their review | Invitation status | Independent evaluation evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Fabio (GitHub handle **to confirm** from the thread) | Adversarial protocol review with runnable counterexamples | Author of the external review on SCQ Discussion #2 (2026-10-30), tracked as Issue #22; findings F1–F5 confirmed and drove merged PRs #23–#27 | The Discussion #2 / Issue #22 thread itself | He has already done this exact job against the pre-publication codebase; ask whether the v0.6.2 dispositions of F1–F7 hold in the published package | Not contacted | None |
| 2 | Weston (`westonale`) | Admission/dependency semantics for agent-driven commerce changes | UCP contributor; defined the MSE mapping cases on UCP #799 (cross-unit dependencies, repair witnesses, re-quoting), validated the v0.3.0 gates, counter-proposal reshaped the admission contract; reviewer on #812/#805 | GitHub (UCP / Agorail repositories) | Knows the MSE admission model from the design side; most likely to catch divergence between the reviewed semantics and the published package | Not contacted | None |
| 3 | Sanj (`sanj-directbooker`) | Price accuracy (ex-Google Hotels, per his public participation) | Practitioner engagement on UCP Discussion #812: provisional discovery vs. authoritative booking, observation-over-identifiers position | GitHub (Agorail repositories) | SCQ's determinacy and quoted-vs-landed reconciliation claims are price-accuracy claims — his professional domain | Not contacted | None |
| 4 | juanferrub | B2B commerce quote flows and pricing state | Shopware practitioner; quote-flow detail on UCP #812; pricing-state proposal on UCP #877 that the maintainer's catalog work builds on | GitHub (Agorail repositories) | Closest practitioner analog to SCQ's quote → acceptance → commit lifecycle in a real B2B platform | Not contacted | None |
| 5 | isparsh510 | Quote semantics in agentic commerce protocols | Author of UCP EP #929 / draft PR #930 (`dev.ucp.common.quote`); the maintainer ran a conformance investigation of that PR | GitHub (Agorail repositories) | Two independent "quote" designs exist — his inside UCP, SCQ standalone; best placed to identify conflicts or interlock | Not contacted | None |
| 6 | chopmob-cloud | Fail-closed protocol engineering; code-level conformance review | Independent practitioner (A202 protocol); reviewed AP2 #332 vectors against implementation code, surfacing the finding behind AP2 Issue #358 / PR #359; authored AP2 PR #310 | GitHub (Agorail repositories) | His demonstrated method — read the code, check the claim, file the counterexample — is exactly the review style these packages need | Not contacted | None |
| 7 | giorgioroth | Independent research; CI/evidence verification | Reviewed the maintainer's draft CI PR in google-agentic-commerce/AP2 (PR #325) | GitHub (Agorail repositories) | Right profile for a blind consumer reproduction: check that documented evidence matches what a fresh install produces (depth of spec-level fit **to confirm**) | Not contacted | None |
| 8 | Federico D'Amato (`damaz91`) | Platform-side review of commerce samples and runnable examples | Google contributor on UCP (CONTRIBUTOR, not maintainer); approved and merged the maintainer's samples PRs #246–#248 (Oct 2026) | GitHub (Agorail repositories) | Reviews runnable code the way a platform consumer would — the exact surface of the consumer examples and onboarding docs | Not contacted | None |
| 9 | Srivatsa03 | Fixture-driven conformance testing | AP2 #332 contributor; delivered fixtures F1–F5 in a specified two-record format against a pinned SDK commit (Oct 2026) | GitHub (Agorail repositories) | Turns semantic gaps into executable cases; SCQ scenarios and MSE relation cases are fixture-shaped (depth **to confirm** — single recorded engagement) | Not contacted | None |

## Rules for using this worksheet

- An invitation is sent only on the maintainer's explicit approval,
  one candidate at a time; sending updates **Invitation status** with
  the date and channel, nothing more.
- A reply, a star, or a conversation is **not** evaluation evidence.
  The last column is filled only with a link to a public,
  inspectable artifact (issue, PR, transcript) — the same standard
  as the [adoption tracker](../ADOPTION-TRACKER.md).
- Deliberately excluded: collaborators with an authorship tie to the
  work itself, and contacts whose only relationship is commercial
  (recruiters, publishers, counsel) — independence of the review
  matters more than reach.
