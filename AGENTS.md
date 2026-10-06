# TrafficWar SDKs — agent guidance

This repository contains transport SDKs, not automatic framework or database
instrumentation. Framework integration examples live under `examples/`.

## Integrating an application

- For Node.js, read `packages/node/AGENTS.md` and `packages/node/README.md`.
  The Node guide is also included in the npm package at
  `node_modules/@trafficwar/node/AGENTS.md`. Agents do not necessarily load
  guidance from dependencies automatically; link it from the application's
  own `AGENTS.md` when integrating the SDK.
- For Python, read `packages/python/README.md` and the actual installed
  version's API. The repository's automatic-batching Python API is still
  unreleased; do not assume `pip install trafficwar` exposes it.
- Keep `event` and `label` stable across requests. Use the canonical taxonomy
  and trace rules in the package README. Never put request IDs or user data
  into labels or dependency aliases.
- Node's `verbose`/`strictCatalog`/`catalogRoot` options are not Python options.
  No framework route discovery or standalone inventory CLI is implemented.

## Maintaining the SDKs

- Keep Node dependency-free, server-only, and compatible with Node 22+;
  examples require Node 22.13+. Python supports 3.9+.
- Preserve the event wire contract, synchronous Node enqueue behavior,
  immutable snapshots, queue bounds, and retry/idempotency behavior.
- Verbose source scanning is optional diagnostics, not proof of instrumentation.
  `strictCatalog` defaults to true: unresolved/empty/incomplete scans
  disable capture without failing initialization; runtime pairs are allowlisted.
  Keep application source available and configure `catalogRoot` as needed.
  Explicit `strictCatalog: false` opts out; verbose and debug remain off by default.
  Do not execute scanned application code or log payloads or credentials.
- Update the package README, agent guide, tests, and `CHANGELOG.md` when a
  public contract changes. Keep agent guidance included in npm packaging.
- Verify Node changes with `npm run check`, `npm test`, `npm run build`, and
  `npm run smoke`. For integration changes, also run
  `npm run check:examples:node` and `npm run test:examples:node`.
- Python checks and build commands are in `CONTRIBUTING.md`.
- Do not publish, push, or bump release versions unless requested. Never
  commit API keys, registry tokens, or customer event payloads.
