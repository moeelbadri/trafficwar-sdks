# Contributing

Issues and pull requests are welcome.

## Setup

Node.js workspace development requires Node 22.13 or newer because the examples
use unflagged `node:sqlite`:

```bash
npm install
npm run check
npm test
npm run build
npm run smoke
npm run check:examples:node
npm run test:examples:node
```

The Python SDK supports Python 3.9 or newer. The complete workspace, including
the Django and FastAPI examples, requires Python 3.10 or newer and
[uv](https://docs.astral.sh/uv/):

```bash
uv sync --all-packages --all-extras --all-groups
uv run --directory packages/python pytest
uv run --directory packages/python ruff check .
uv run --directory packages/python ruff format --check .
uv run --directory packages/python mypy src
uv run --directory examples/python/django pytest
uv run --directory examples/python/fastapi pytest
uv build --package trafficwar
```

Add tests for behavioral changes. Keep browser-only behavior out of these
server SDKs, and never commit API keys, registry tokens, or customer event
payloads.

By contributing, you agree that your contribution is licensed under the
repository's MIT license.
