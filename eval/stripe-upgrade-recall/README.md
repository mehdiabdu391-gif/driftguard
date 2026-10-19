# Stripe upgrade check: hits and misses

How many of the request-side breaks that a Stripe API upgrade causes does `drift upgrade` find, and how many does it miss? Measured on public code, 2026-10-19, upgrading each repository's pinned version to `2026-09-30.endive`.

## Sample

The first 30 distinct repositories returned by three GitHub code searches, in result order, with no filtering on outcome:

- `apiVersion "checkout.sessions.create" language:TypeScript`
- `apiVersion "subscriptions.create" language:JavaScript`
- `apiVersion "paymentIntents.create" language:TypeScript`

Two repositories already used as examples elsewhere in this project were dropped so they could not inflate the result, leaving 28. Repositories are listed here by number only; this study does not publish findings about named projects.

## Ground truth

`truth.py` is a separate implementation written for this check. It does not use DriftGuard's parser, matcher or verifier:

- finds Stripe SDK calls with a regular expression, keeping chains that are methods of stripe-node (via the published method map),
- reads the first object argument by bracket matching, top-level keys and literal string values only,
- looks each key up directly in the two Stripe spec snapshots (the pinned version and the target): a key accepted before and not after is a removal; a literal value accepted before and not after is an enum removal; a top-level field required after, not before, and not sent by a fully literal argument is a new requirement.

Every expected break was then checked against Stripe's own changelog. Both kinds that occurred are documented as breaking by Stripe:

- `payment_method_types` removed from Checkout Sessions in `2026-09-30.endive`,
- `ui_mode` values `hosted`, `embedded` and `custom` replaced in `2026-03-25.dahlia` ("Attempting to set a Checkout Session's ui_mode to hosted, embedded or custom will fail").

## Result

| | Count |
|---|---|
| Repositories | 28 (26 with a pinned version DriftGuard could attribute) |
| Stripe SDK call sites found by the regex | 98 (one is commented-out code) |
| Call sites DriftGuard resolved | 93, plus 3 listed as unresolved (method maps to several endpoints) |
| Resolved calls not checked because no pin was attributable | 2 (listed in the report with the reason) |
| Expected breaks | 7 in 7 repositories |
| Confirmed by DriftGuard | 6 |
| **Missed** | **1** |
| Confirmed findings not in the ground truth | 0 |
| Possible findings (not counted as hits) | 8 |

Recall on this sample: 6 of 7. Precision of confirmed findings: 6 of 6.

### The miss

repo-28 calls Stripe through a lazily initialised client wrapped in `new Proxy({} as Stripe, { get(...) {...} })`. DriftGuard does not follow a Proxy, so all 3 calls in that repository were invisible to it: not resolved, not listed as unresolved. That is the worst kind of miss, a silent one, and it is recorded here as such.

### Fixed during this study

A client created from a dynamic import (`const { default: Stripe } = await import('stripe')`, common in Next.js route handlers) was not detected. That is fixed and covered by a regression test. No expected break depended on it in this sample.

## Limits of this measurement

- The ground truth checks top-level fields only. Nested fields, query parameters and endpoint removals that a top-level check cannot see are not counted, so recall on those is not measured here.
- Both implementations read the same two spec snapshots and the same stripe-node method map. A wrong snapshot or a wrong map entry would fool both.
- 28 repositories and 7 breaks is a small sample. The 6 of 7 figure says the approach works on common Checkout code; it is not a general recall rate.
- Response-side breaks are not checked by either side.

## Reproduce

```bash
# clone the sample into repos/<owner>_<name>, then for each:
node bin/drift.js upgrade repos/<dir> --format json --output out/<dir>.json --fail-on never
DRIFTGUARD_DATA=data REPOS=repos OUT=truth.json python3 eval/stripe-upgrade-recall/truth.py <dir> ...
```

`results.json` has the per-repository numbers.
