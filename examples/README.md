# Framework examples

These runnable applications show the server SDKs around the same flow:

1. receive `GET /hello/:name`,
2. query a seeded SQLite database with a parameterized lookup,
3. enqueue a `hello.request` event without blocking on delivery,
4. return the SQLite result.

Available examples:

- Node.js: [Express](node/express), [Elysia](node/elysia), and
  [NestJS](node/nestjs)
- Python: [Django](python/django) and [FastAPI](python/fastapi)

Each project has its own README and integration tests. Tests instantiate the
real local SDK and replace its outbound HTTP transport with a fake ingest
endpoint. They explicitly flush before inspecting captured requests, assert
that `/v1/server/batch` receives bare arrays with generated UUIDv7 event IDs,
and close every SDK client. They never need a production key or contact
TrafficWar.

The production entry points stop accepting requests and then call `close()` or
await `close()`/`aclose()` during framework shutdown. Close already flushes the
queue, so the examples do not add a separate shutdown flush.
