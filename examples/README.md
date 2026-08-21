# Framework examples

These runnable applications show the server SDKs around the same flow:

1. receive `GET /hello/:name`,
2. query a seeded SQLite database with a parameterized lookup,
3. send a durable `hello.request` event through TrafficWar,
4. return the SQLite result.

Available examples:

- Node.js: [Express](node/express), [Elysia](node/elysia), and
  [NestJS](node/nestjs)
- Python: [Django](python/django) and [FastAPI](python/fastapi)

Each project has its own README and integration tests. Tests instantiate the
real local SDK and replace its outbound HTTP transport with a fake ingest
endpoint. They never need a production key and never contact TrafficWar.
