# NestJS 11 example

A small NestJS 11 API with a module, controller, and service. The service reads
a seeded greeting from Node's built-in in-memory SQLite database, enqueues a
TrafficWar event, and lets the controller respond without waiting for delivery.
It requires Node.js 22.13 or newer for unflagged `node:sqlite`.

## Run

From the repository root, install the workspaces and build the local SDK:

```sh
npm install
npm run build
```

Then start this example:

```sh
TRAFFICWAR_API_KEY=replace-me npm start --workspace @trafficwar/example-nestjs
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
npm test --workspace @trafficwar/example-nestjs
npm run check --workspace @trafficwar/example-nestjs
```

The e2e test creates a Nest `TestingModule`, calls it with Supertest, and
injects a real local `@trafficwar/node` client configured with a fake Fetch
implementation. It never contacts production. The test explicitly flushes
before inspecting the bare `/v1/server/batch` arrays and generated UUIDv7 event
IDs.

`TrafficWarLifecycle` implements Nest's `OnApplicationShutdown` hook and awaits
`trafficwar.close()`. Thus `app.close()` and enabled process shutdown hooks
flush and close the SDK exactly once while the service shutdown hook closes
SQLite; no separate shutdown flush is needed.
