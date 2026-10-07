import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "trafficwar-node-"));
const consumerRoot = join(temporaryRoot, "consumer");

try {
  const packed = JSON.parse(execFileSync("npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot, encoding: "utf8" }));
  assert.equal(typeof packed[0]?.filename, "string");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--no-package-lock", "--prefix", consumerRoot, join(temporaryRoot, packed[0].filename)],
  { stdio: "inherit" });

  assert.equal(readFileSync(join(consumerRoot, "node_modules", "@trafficwar", "node", "AGENTS.md"), "utf8"),
    readFileSync(join(packageRoot, "AGENTS.md"), "utf8"));
  assert.ok(!packed[0].files.some(file => file.path.includes("THIRD-PARTY-NOTICES") || file.path.includes("catalog.json")));

  writeFileSync(join(consumerRoot, "runtime.mjs"), `
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const esm = await import("@trafficwar/node");
const cjs = createRequire(import.meta.url)("@trafficwar/node");
for (const sdk of [esm, cjs]) {
  const sent = [], posts = [], logs = [];
  const client = new sdk.TrafficWar({
    apiKey: "packed-secret", compression: "none", verbose: true,
    fetch: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer packed-secret");
      if (url.endsWith("/catalog")) {
        const payload = JSON.parse(init.body);
        posts.push(payload);
        return new Response(JSON.stringify({ status: "ok", added: payload.captures.length }));
      }
      const events = JSON.parse(Buffer.from(init.body).toString());
      sent.push(...events);
      return new Response(JSON.stringify({ status: "ok", accepted: events.length, ingest_id: "packed" }));
    },
  });
  assert.equal(posts.length, 0);
  for (const field of ["staticCatalog", "strictCatalog", "captureEnabled"]) assert.ok(!(field in client));
  const info = console.info;
  console.info = message => logs.push(message);
  try {
    function work(input) { client.capture(input); }
    const first = { event: "database", label: "First", latency_ms: 3 };
    work(first);
    first.label = "Caller mutation";
    work({ event: "redis", label: "Changed", latency_ms: 19 });
    assert.equal((await client.flush()).accepted, 2);
    work({ event: "database", label: "First" });
    work({ event: "http", label: "Delta" });
    assert.equal((await client.close()).accepted, 2);
    assert.deepEqual(posts, [
      { captures: [{ event: "database", label: "First", station_known: false }, { event: "redis", label: "Changed", station_known: false }] },
      { captures: [{ event: "http", label: "Delta", station_known: false }] },
    ]);
    assert.deepEqual(sent.slice(0, 2).map(e => [e.event, e.label, e.latency_ms]),
      [["database", "First", 3], ["redis", "Changed", 19]]);
    assert.equal(logs.length, 3);
    assert.ok(logs.every(message => message.includes("registered pair") && !message.includes("packed-secret")));
  } finally { console.info = info; }
}
assert.ok(!readdirSync(join(process.cwd(), "node_modules", "@trafficwar", "node")).some(name => name.includes("catalog.json")));
`);
  // Fresh process runs observe/register again; no JSON checkpoints survive.
  for (let run = 0; run < 2; run++) {
    execFileSync(process.execPath, ["runtime.mjs"], { cwd: consumerRoot, stdio: "inherit" });
  }

  for (const filename of ["esm.mts", "cjs.cts"]) {
    writeFileSync(join(consumerRoot, filename), `
import { TrafficWar, type FlushResult, type S3Source, type TrafficWarEvent } from "@trafficwar/node";
const event: TrafficWarEvent = { event: "http", http_method: "GET" };
const source: S3Source = "assets.ovh-s3";
const client = new TrafficWar({ apiKey: "test-key" });
client.capture([event, { event: "s3", source, operation_type: "s3.get_object" }]);
const pending: Promise<FlushResult> = client.flush();
void pending;
// @ts-expect-error Removed catalog switches must not be part of the API.
new TrafficWar({ apiKey: "test-key", strictCatalog: false });
// @ts-expect-error Removed explicit catalog type must not be exported.
import type { TrafficWarCatalogEntry } from "@trafficwar/node";
`);
  }
  execFileSync(process.execPath, [join(dirname(require.resolve("typescript/package.json")), "bin", "tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "esm.mts", "cjs.cts"],
  { cwd: consumerRoot, stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(join(consumerRoot, "node_modules", "@trafficwar", "node", "package.json"), "utf8"));
  assert.equal(manifest.name, "@trafficwar/node");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
