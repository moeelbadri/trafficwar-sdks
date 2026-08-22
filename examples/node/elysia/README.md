# Elysia Node example

A small Elysia API using the `@elysiajs/node` adapter. It reads a seeded
greeting from Node's built-in in-memory SQLite database, enqueues a TrafficWar
event, and responds without waiting for delivery.
It requires Node.js 22.13 or newer for unflagged `node:sqlite`.

## Run

From the repository root, install the workspaces and build the local SDK:

```sh
npm install
npm run build
```

Then start this example:

```sh
TRAFFICWAR_API_KEY=replace-me npm start --workspace @trafficwar/example-elysia
```

`PORT` defaults to `3000`. `TRAFFICWAR_BASE_URL` can override the ingest
origin for a local or staging environment.

```sh
curl http://localhost:3000/hello/Ada
```

The response is:

```json
{"id":1,"name":"Ada","message":"Hello, Ada!"}
```

## Test

```sh
npm test --workspace @trafficwar/example-elysia
npm run check --workspace @trafficwar/example-elysia
```

The test exercises `app.handle` with the real local `@trafficwar/node` client
and an injected fake Fetch implementation. It never contacts a production
service. Tests explicitly flush before inspecting bare `/v1/server/batch`
arrays, verify generated UUIDv7 event IDs, and close both the SDK client and
the in-memory SQLite database. A delivery-failure case also confirms that the
handler response is not delayed and that `flush()` surfaces the retained
failure.

On `SIGINT` or `SIGTERM`, the entry point stops Elysia, awaits
`trafficwar.close()`, and then closes SQLite. SDK close already flushes the
queue, so shutdown does not issue a separate flush.
