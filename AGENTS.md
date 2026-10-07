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
- Node automatically registers exact observed event/label pairs only after
  successful capture validation and queue acceptance. Values are never pinned
  to a code location or rewritten. Use one long-lived client per service/key.
  Do not create fake captures or declarations; there is no startup inventory.
- Catalog memory is per client and not persistent. No scanning, filesystem,
  JSON, API polling, explicit catalog, or strict/static options are supported.
  Python does not yet register observed pairs.

## Maintaining the SDKs

- Keep Node dependency-free, server-only, and compatible with Node 22+;
  examples require Node 22.13+. Python supports 3.9+.
- Preserve the event wire contract, synchronous Node enqueue behavior,
  immutable snapshots, queue bounds, and retry/idempotency behavior.
- Keep one in-memory sent/pending pair list per client. Coalesce discoveries
  for a fixed 1-second window, serialize uploads, send unsent deltas only, and
  mark sent only on success. POST event,label,station_known:false only to the
  additive backend; actual events supply station metadata. Catalog failures
  use onError safely, retain pending identities and retry on bounded cooldowns,
  not per capture. flush/close await work without failing event delivery.
- Never rewrite event/label values, restore scanning/persistence, log payloads
  or credentials, or make catalog-valid labels a requirement for valid events.
  Keep debug diagnostics; verbose logs successful new registrations only.
- Server deletion does not clear a running client's sent memory; restart and
  observe the pair again to register it anew. Keep labels low-cardinality.
- Update the package README, agent guide, tests, and `CHANGELOG.md` when a
  public contract changes. Keep agent guidance included in npm packaging.
- Verify Node changes with `npm run check`, `npm test`, `npm run build`, and
  `npm run smoke`. For integration changes, also run
  `npm run check:examples:node` and `npm run test:examples:node`.
- Python checks and build commands are in `CONTRIBUTING.md`.
- Do not publish, push, or bump release versions unless requested. Never
  commit API keys, registry tokens, or customer event payloads.
