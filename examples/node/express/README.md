# Express 5 example

A small Express 5 API that reads a seeded greeting from Node's built-in
in-memory SQLite database and awaits a TrafficWar capture before responding.
It requires Node.js 22.13 or newer for unflagged `node:sqlite`.

## Run

From the repository root, install the workspaces and build the local SDK:

```sh
npm install
npm run build
```

Then start this example:

```sh
TRAFFICWAR_API_KEY=replace-me npm start --workspace @trafficwar/example-express
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
npm test --workspace @trafficwar/example-express
npm run check --workspace @trafficwar/example-express
```

The test uses the real local `@trafficwar/node` client with an injected fake
Fetch implementation. It only calls the local Express server and never sends
traffic to the production ingest service. The HTTP server and SQLite database
are closed after each run.
