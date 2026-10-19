# DriftGuard

**Know what breaks before you bump your Stripe API version.** Point DriftGuard at your code and it names the exact lines that stop working when your pinned Stripe version moves to a newer one: the file and line, the field or value Stripe removed, and the two spec snapshots that prove it.

```
$ drift upgrade .
Stripe API upgrade from 2023-10-16 to 2026-09-30.endive, checked against 7 resolved Stripe call sites (0 unresolved).

CONFIRMED (1)
  landing/run.ts:266  const session = await stripe.checkout.sessions.create({
    Stripe API: POST /v1/checkout/sessions — removed the request property `payment_method_types`
    why: this call sends "payment_method_types" (line 268), which the spec no longer accepts
    spec check: verified (property "payment_method_types" is no longer declared in the revision spec)
    source: https://github.com/stripe/openapi/compare/0ba185f3d96c3fee739b01aaa46fa86245da1f0b...bcfd59f49dcac84a84d63d304c62793dff6e5916 (upgrade 2023-10-16 -> 2026-09-30.endive)
```

That is real output on a public repository ([mayfer/dbpill](https://github.com/mayfer/dbpill) at `b5b1769`). On 28 public Stripe codebases it found 6 of the 7 upgrade breaks a separate check expected, with no false confirmed findings; the one miss and how it was measured are in [eval/stripe-upgrade-recall](eval/stripe-upgrade-recall/README.md).

It is also **Dependabot for the other APIs you call**: the same scanner watches the official OpenAPI specs of Stripe, OpenAI, GitHub and Twilio and flags the lines an upstream breaking change hits as it lands.

## Quickstart

### GitHub Action

Add `.github/workflows/api-drift.yml`:

```yaml
name: API drift
on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1'   # weekly, Monday 06:00 UTC
permissions:
  contents: read
  pull-requests: write    # only needed for the PR comment
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mehdiabdu391-gif/driftguard@stable
```

On every pull request and once a week it:

- annotates the affected lines in the PR diff,
- writes a report to the job summary and (on PRs) one comment that it keeps updated,
- **fails only on confirmed breaks**.

Inputs: `path` (default `.`), `window` (`30`, `90` or `180` days, default `90`), `fail-on` (`confirmed`, `possible` or `never`), `exclude` (space-separated path prefixes), `comment` (`true`/`false`), `data` (a local data directory; default is the latest published data). Outputs: `confirmed`, `possible`.

`@stable` is a branch that only moves forward to commits that passed CI, so your workflow never runs work in progress from `main`. Spec data is not tied to it: every run downloads the latest published changes.

To check a Stripe upgrade in CI instead (for example on the pull request that bumps `apiVersion` or the SDK), use `command: upgrade`, optionally with `from` and `to`:

```yaml
      - uses: mehdiabdu391-gif/driftguard@stable
        with:
          command: upgrade
          to: '2026-09-30.endive'   # default: the newest version Stripe has published
```

### CLI

```bash
npx github:mehdiabdu391-gif/driftguard upgrade .                      # Stripe: each client's pin -> newest
npx github:mehdiabdu391-gif/driftguard upgrade . --from 2023-10-16    # code with no literal pin
npx github:mehdiabdu391-gif/driftguard scan .
# or, from a clone
node bin/drift.js scan /path/to/repo --format markdown --window 180
```

`upgrade` takes `--from <version>` (default: each Stripe client's literal `apiVersion`) and `--to <version>` (default: the newest published). Both: `--format text|markdown|json`, `--output <file>`, `--json-output <file>` (JSON too, from the same scan), `--data <dir>`, `--fail-on confirmed|possible|never`, `--exclude <prefix>`, `--annotations`. Exit code is 1 when the fail-on level is reached, 2 on an error.

## How it works

1. **Spec tracker.** A scheduled GitHub Action snapshots each provider's published spec by upstream commit SHA, runs [oasdiff](https://github.com/oasdiff/oasdiff) between consecutive snapshots and over 30/90/180-day windows, and publishes normalized change records to the `data` branch. Window diffs are net, so changes that were later reverted are not reported.
2. **Independent verification.** oasdiff is a structural differ, and refactors fool it. For example, when OpenAI moved the `quality` enum of `POST /images/generations` under `anyOf`, oasdiff reported every value as removed. DriftGuard re-resolves each claim in both spec documents (through `$ref`, `allOf`, `anyOf`, `oneOf` and array items) and marks it `verified`, `refuted` or `unverified`. Refuted claims are never reported.
3. **SDK maps from SDK source.** Method-to-endpoint maps are generated from each official SDK's own code at a pinned commit: `api.md` for openai-node and openai-python, `src/resources` for stripe-node, the service and resource classes for stripe-python, and the endpoint table for Octokit. Nothing is hand-written.
4. **Call-site scanner.** tree-sitter (WebAssembly, no native build) parses TypeScript, JavaScript and Python. It follows clients across files (relative imports, `tsconfig` path aliases, Python packages), factories like `getStripe()`, class fields, and type annotations. It also finds raw `fetch`, `axios`, `requests` and `httpx` calls to the providers' hosts and matches them against the spec's path templates.
5. **Matcher.** A change and a call are joined only when they name the same operation. The literal arguments decide the level:

| Level | Meaning |
|---|---|
| **confirmed** | The change is verified, and the call provably sends a removed field, omits a newly required one, sends a removed enum value, or calls a removed endpoint. |
| **possible** | Same operation, but it can't be proven statically (spread arguments, a params variable, or a change kind with no independent check). |
| **deprecated** | The call uses an endpoint or field the spec now marks deprecated. |
| **unresolved** | A provider call that couldn't be pinned to one operation, with the reason. It is listed but not checked. |

### Upgrade check (Stripe)

Stripe publishes its spec to [stripe/openapi](https://github.com/stripe/openapi), and every snapshot names the API version it describes in `info.version`. The tracker reads that field at every one of the 1,200+ commits of `openapi/spec3.json` since 2017 and publishes an index of which commits describe which version. No sampling: Stripe has re-published an older version after a newer one (2024-11-20.acacia on 2024-12-13, between two 2024-12-18.acacia snapshots), so the history is not strictly ordered. A version maps to the last snapshot Stripe published for it.

`drift upgrade` then compares, for each operation your code calls, the snapshot of the version you pin with the snapshot of the target: removed operations, removed request properties (to a depth of six), newly required ones, dropped enum values, removed query parameters, new deprecations. Each change goes through the same verifier and matcher as a regular scan, so **confirmed** means the same thing. Only the operations you call are compared, which keeps a three-year upgrade within a normal CI runner's memory; a whole-spec diff across that span does not.

What to keep in mind: a snapshot is Stripe's published description of a version, not a recording of the API's behaviour, and the last snapshot of an old version can include documentation fixes made after its release. Calls whose client has no literal pin are listed as not checked unless you pass `--from`. Response schemas are not compared.

## What it does not do (yet)

- **Response fields aren't traced.** Response-schema changes on operations you call are counted, not matched to the fields your code reads.
- **Stripe is versioned.** A Stripe spec change reaches you when your API version moves forward. `scan` shows the pinned version next to each finding; `upgrade` checks the move itself. A pin set at runtime, per request, or in the Stripe dashboard is not visible in code; pass `--from`.
- **Upgrade mode is Stripe only.** OpenAI and Twilio do not publish versioned specs the same way; GitHub's REST versions are separate documents.
- **Twilio SDK calls are detected but not mapped.** They're reported as unresolved. Raw HTTP calls to Twilio are resolved.
- **SDK maps are built from the latest SDK.** A method that exists only in an older SDK version shows up as unresolved.
- **Bindings follow names within a file and imports between files.** Dynamic dispatch, clients wrapped in a `Proxy`, and clients passed through untyped function parameters aren't followed. A `Proxy`-wrapped client was the one miss in the recall check above.
- **No impact ranking yet.** Findings are ordered by level and location. Reach-based ranking (which routes depend on a call) is planned, not faked.

## Data and site

Tracker output is published to the [`data` branch](https://github.com/mehdiabdu391-gif/driftguard/tree/data) as one commit that each run replaces, so the repository doesn't grow with data. Scans download it (under 1 MB compressed), cache it for six hours, and fall back to the cache with a warning if GitHub is unreachable. With no data at all a scan stops with an error rather than reporting a clean result.

- `specs/<id>.json`: snapshot state and history per spec
- `changes/<id>/commits/*.json`: per-commit changes
- `changes/<id>/window-<N>d.json`: net changes per window
- `operations/<id>.json`: operation index per spec
- `versions/stripe.json`: Stripe API version -> spec snapshot commits
- `sdk-maps/<sdk>.json`: method maps with their source commit

The landing page and Atom feed (`feed.xml`) are built by the same workflow and deployed to GitHub Pages; nothing is committed for them.

Maintainers: clone the `data` branch into `data/` (`git clone -b data <repo> data`), then `drift track` (needs `oasdiff` on `PATH`), `drift sdk-maps`, `drift site`, `npm test`, `npm run typecheck`.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Mehdi Abdu Mohammed. Free to use, including commercially and in company CI. See [NOTICE](NOTICE).
