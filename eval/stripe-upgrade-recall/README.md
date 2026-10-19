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

Two runs on the same sample. The first found a silent miss; the fixes it led to are in the second.

| | First run | After fixes |
|---|---|---|
| Repositories with a pinned version DriftGuard could attribute | 26 of 28 | 27 of 28 |
| Stripe SDK call sites found by the regex (one is commented-out code) | 98 | 98 |
| Call sites DriftGuard resolved | 93 | 96 |
| Listed as unresolved (method maps to several endpoints) | 3 | 3 |
| Resolved but not checked: no attributable pin (listed with the reason) | 2 | 1 |
| Expected breaks | 7 in 7 repositories | 7 |
| Confirmed by DriftGuard | 6 | **7** |
| **Missed** | **1** | **0** |
| Confirmed findings not in the ground truth | 0 | 0 |
| Possible findings (not counted as hits) | 8 | 9 |

The one remaining not-checked call (repo-18) takes its client from a constructor option, `cfg.client ?? new Stripe(...)`, so the version it runs at depends on the caller. Listing it as not checked is the correct answer.

### The miss in the first run, and the fixes

repo-28 calls Stripe through a lazily initialised client wrapped in `new Proxy({} as Stripe, { get(...) { const instance = getStripe(); ... } })`. DriftGuard did not follow a Proxy, so all 3 calls in that repository were invisible: not resolved, not listed as unresolved. A silent miss.

Fixed, each with a regression test:

- A `Proxy` whose target is asserted as an SDK class (`{} as Stripe`) or whose handler obtains a client is treated as that client. It takes an API version pin only when every client the handler obtains agrees on one.
- Pins now survive factories. `getStripe()` returning a client built with `apiVersion` used to lose the pin at the call; nested factories (`getStripeInstance()` returning `getStripe()`) keep it too.
- A lazily initialised `let stripe: Stripe | null` takes the pin of the client later assigned to it. If one name is assigned clients with two different pins, the pin is unknown and the call is listed as not checked, instead of taking whichever came first.
- A client created from a dynamic import (`const { default: Stripe } = await import('stripe')`) is detected.
- `drift upgrade` / `drift scan` on a path that does not exist is an error. Before, it scanned zero files and reported a clean result.

These fixes were written after seeing this sample, so the second run's 7 of 7 is not an unbiased estimate. A fresh sample is the honest next measurement.

## Fresh sample (measured before any fix it led to)

To get a number not shaped by the fixes above, 30 new repositories: the first distinct results of three different searches (`apiVersion "checkout.sessions.create" language:JavaScript`, `apiVersion "customers.create" language:TypeScript`, `apiVersion "billingPortal.sessions.create" language:TypeScript`), skipping every repository used before. Same ground-truth script.

| | |
|---|---|
| Repositories with a pin DriftGuard could attribute | 23 of 30 |
| Stripe SDK call sites found by the regex | 251 |
| Resolved by DriftGuard | 216 (2 more listed as unresolved) |
| Resolved but not checked (no attributable pin, listed) | 68 |
| Breaks the regex script expected | 19 |
| ...of which inside template strings (code a CLI writes out, never run) | 2 |
| **Real expected breaks** | **17** |
| **Confirmed by DriftGuard** | **15** |
| **Missed** | **2** |
| Confirmed findings not in the ground truth | 0 |

**Recall on the fresh sample: 15 of 17.** This is the number to quote.

Misses, both fixed afterwards with regression tests:
- a client created in a ternary, `key ? new Stripe(key, { apiVersion }) : null`;
- a class taken from `(await import('stripe')).default`.

A coverage gap was also fixed: a client returned by a static class method (`StripeService.getInstance()`, in the same file or an imported class) was not followed, leaving one repository's 9 calls silently unchecked.

After the fixes, the same 30 repositories: 242 call sites resolved (was 216), all 17 real breaks confirmed, still 0 confirmed findings outside the ground truth. Like the first sample's rerun, that is not an unbiased number; 15 of 17 is.

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
