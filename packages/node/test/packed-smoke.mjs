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

  writeFileSync(
    join(consumerRoot, "esm.mjs"),
    `import assert from "node:assert/strict";
import { TrafficWar, TrafficWarError } from "@trafficwar/node";
assert.equal(typeof TrafficWar, "function");
assert.equal(typeof TrafficWarError, "function");
`,
  );
  writeFileSync(
    join(consumerRoot, "cjs.cjs"),
    `const assert = require("node:assert/strict");
const { TrafficWar, TrafficWarError } = require("@trafficwar/node");
assert.equal(typeof TrafficWar, "function");
assert.equal(typeof TrafficWarError, "function");
`,
  );
  writeFileSync(
    join(consumerRoot, "esm.mts"),
    `import { TrafficWar, type FlushResult, type TrafficWarEvent } from "@trafficwar/node";
const event: TrafficWarEvent = { event: "esm.typecheck" };
const client = new TrafficWar({ apiKey: "test-key" });
client.capture([event]);
const pending: Promise<FlushResult> = client.flush();
void pending;
`,
  );
  writeFileSync(
    join(consumerRoot, "cjs.cts"),
    `import { TrafficWar, type FlushResult, type TrafficWarEvent } from "@trafficwar/node";
const event: TrafficWarEvent = { event: "cjs.typecheck" };
const client = new TrafficWar({ apiKey: "test-key" });
client.capture([event]);
const pending: Promise<FlushResult> = client.flush();
void pending;
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
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
