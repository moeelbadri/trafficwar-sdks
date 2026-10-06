import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = realpathSync(
  fileURLToPath(new URL("..", import.meta.url)),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "trafficwar-node-"));
const consumerRoot = join(temporaryRoot, "consumer");

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    ),
  );
  const filename = packed[0]?.filename;
  assert.equal(typeof filename, "string");
  const tarball = join(temporaryRoot, filename);

  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      consumerRoot,
      tarball,
    ],
    { stdio: "inherit" },
  );

  assert.equal(
    readFileSync(join(consumerRoot, "node_modules", "@trafficwar", "node", "AGENTS.md"), "utf8"),
    readFileSync(join(packageRoot, "AGENTS.md"), "utf8"),
  );
  assert.equal(
    readFileSync(join(consumerRoot, "node_modules", "@trafficwar", "node", "THIRD-PARTY-NOTICES.md"), "utf8"),
    readFileSync(join(packageRoot, "THIRD-PARTY-NOTICES.md"), "utf8"),
  );
  writeFileSync(
    join(consumerRoot, "catalog.ts"),
    'import { TrafficWar } from "@trafficwar/node"; const client = new TrafficWar({apiKey:"test"}); client.capture({ event: "http", label: "Checkout" });\n',
  );

  writeFileSync(
    join(consumerRoot, "esm.mjs"),
    `import assert from "node:assert/strict";
import { TrafficWar, TrafficWarError } from "@trafficwar/node";
assert.equal(typeof TrafficWar, "function");
assert.equal(typeof TrafficWarError, "function");
const logs = [];
const info = console.info;
try {
  console.info = (message) => logs.push(message);
  new TrafficWar({ apiKey: "packed-secret", strictCatalog: false, verbose: true, catalogRoot: process.cwd(), fetch: async () => new Response(JSON.stringify({status:"ok",added:0})) });
} finally {
  console.info = info;
}
assert.equal(logs.length, 1);
assert.ok(logs[0].includes("http  Checkout  catalog.ts:1"));
assert.ok(!logs[0].includes("packed-secret"));
`,
  );
  writeFileSync(
    join(consumerRoot, "cjs.cjs"),
    `const assert = require("node:assert/strict");
const { TrafficWar, TrafficWarError } = require("@trafficwar/node");
assert.equal(typeof TrafficWar, "function");
assert.equal(typeof TrafficWarError, "function");
const logs = [];
const info = console.info;
try {
  console.info = (message) => logs.push(message);
  new TrafficWar({ apiKey: "packed-secret", strictCatalog: false, verbose: true, catalogRoot: process.cwd(), fetch: async () => new Response(JSON.stringify({status:"ok",added:0})) });
} finally {
  console.info = info;
}
assert.equal(logs.length, 1);
assert.ok(logs[0].includes("http  Checkout  catalog.ts:1"));
assert.ok(!logs[0].includes("packed-secret"));
`,
  );
  writeFileSync(
    join(consumerRoot, "esm.mts"),
    `import { TrafficWar, type FlushResult, type S3Source, type TrafficWarEvent } from "@trafficwar/node";
const event: TrafficWarEvent = { event: "http", http_method: "GET" };
const s3Source: S3Source = "assets.ovh-s3";
const client = new TrafficWar({ apiKey: "test-key", strictCatalog: true, catalogRoot: "./src" });
const enabled: boolean = client.captureEnabled;
void enabled;
client.capture([event, { event: "s3", source: s3Source, operation_type: "s3.get_object" }]);
const pending: Promise<FlushResult> = client.flush();
void pending;
`,
  );
  writeFileSync(
    join(consumerRoot, "cjs.cts"),
    `import { TrafficWar, type FlushResult, type S3Source, type TrafficWarEvent } from "@trafficwar/node";
const event: TrafficWarEvent = { event: "http", http_method: "GET" };
const s3Source: S3Source = "assets.ovh-s3";
const client = new TrafficWar({ apiKey: "test-key", strictCatalog: true, catalogRoot: "./src" });
const enabled: boolean = client.captureEnabled;
void enabled;
client.capture([event, { event: "s3", source: s3Source, operation_type: "s3.get_object" }]);
const pending: Promise<FlushResult> = client.flush();
void pending;
`,
  );

  writeFileSync(
    join(consumerRoot, "guard.mjs"),
    `import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const esm = await import("@trafficwar/node");
const cjs = createRequire(import.meta.url)("@trafficwar/node");
const root = join(process.cwd(), "guard-source");
mkdirSync(root);
const error = console.error;
const logs = [];
try {
  console.error = (message) => logs.push(message);
  for (const sdk of [esm, cjs]) {
    const binding = 'import { TrafficWar } from "@trafficwar/node"; const client = new TrafficWar({apiKey:"test"}); ';
    writeFileSync(join(root, "app.ts"), binding + 'const identity = { event: "http", label: "Checkout" } as const; const send = client.capture.bind(client); send(identity);');
    let calls = 0;
    const options = {
      apiKey: "packed-guard-secret", catalogRoot: root, compression: "none",
      fetch: async (url) => {
        calls += 1;
        if (url.endsWith('/catalog')) return new Response(JSON.stringify({status:"ok",added:1}));
        return new Response(JSON.stringify({ status: "ok", accepted: 1, ingest_id: "packed" }));
      },
    };
    const client = new sdk.TrafficWar(options);
    assert.equal(client.strictCatalog, true);
    assert.equal(client.captureEnabled, true);
    assert.throws(() => client.capture({ event: "http", label: "Unknown" }), sdk.TrafficWarValidationError);
    client.capture({ event: "http", label: "Checkout" });
    assert.equal((await client.close()).accepted, 1);
    assert.equal(calls, 2);
    writeFileSync(join(root, "app.ts"), binding + 'client["capture"]?.({ event: "http", label: routeName });');
    const blocked = new sdk.TrafficWar(options);
    assert.equal(blocked.captureEnabled, false);
    blocked.capture({ event: "http", label: "Checkout" });
    assert.equal((await blocked.flush()).accepted, 0);
    assert.equal((await blocked.close()).accepted, 0);
    assert.equal(calls, 2);
    const optedOut = new sdk.TrafficWar({ ...options, strictCatalog: false });
    assert.equal(optedOut.strictCatalog, false);
    assert.equal(optedOut.captureEnabled, true);
    optedOut.capture({ event: "http", label: "Not in catalog" });
    assert.equal((await optedOut.close()).accepted, 1);
    assert.equal(calls, 3);
  }
} finally {
  console.error = error;
}
assert.equal(logs.length, 2);
assert.ok(logs.every((message) => message.includes("app.ts:1: label missing or not a statically resolved string")));
assert.ok(logs.every((message) => !message.includes("packed-guard-secret")));
`,
  );

  execFileSync(process.execPath, ["esm.mjs"], {
    cwd: consumerRoot,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["cjs.cjs"], {
    cwd: consumerRoot,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["guard.mjs"], {
    cwd: consumerRoot,
    stdio: "inherit",
  });

  const typescriptRoot = dirname(require.resolve("typescript/package.json"));
  const tsc = join(typescriptRoot, "bin", "tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "esm.mts",
      "cjs.cts",
    ],
    {
      cwd: consumerRoot,
      stdio: "inherit",
    },
  );

  const manifest = JSON.parse(
    readFileSync(
      join(consumerRoot, "node_modules", "@trafficwar", "node", "package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "@trafficwar/node");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
