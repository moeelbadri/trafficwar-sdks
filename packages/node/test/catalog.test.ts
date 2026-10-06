import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { discoverCaptures, formatCaptureCatalog, formatCatalogIssues } from "../src/catalog";

const directories: string[] = [];
const SDK_BINDINGS = "import { TrafficWar } from '@trafficwar/node'; const client = new TrafficWar({apiKey: 'test'}); const trafficwar = client; ";

function fixture(files: Record<string, string>, addBindings = true): string {
  const root = mkdtempSync(path.join(tmpdir(), "trafficwar-scan-"));
  directories.push(root);
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, (addBindings ? SDK_BINDINGS : "") + source);
  }
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("discoverCaptures", () => {
  it("retains static station identity but marks runtime metadata unknown", () => {
    const scan = discoverCaptures(fixture({ "app.ts": [
      'client.capture({ event:"s3", label:"Upload", source:"assets.ovh-s3", span_kind:"client", operation_type:"s3.put_object" });',
      'client.capture({ event:"http", label:"Home", source: process.env.HOST, span_kind:"server" });',
      'client.capture({ ...runtime, event:"redis", label:"Cache" });',
      'client.capture({ event:"http", label:"Empty", source: undefined });',
    ].join("\n") }));
    expect(scan.issues).toEqual([]);
    expect(scan.captures[0]).toMatchObject({ event:"s3", source:"assets.ovh-s3", span_kind:"client", operation_type:"s3.put_object" });
    expect(scan.captures[0]?.station_known).toBeUndefined();
    expect(scan.captures[1]).toMatchObject({ label:"Home", station_known:false, span_kind:"server" });
    expect(scan.captures[1]?.source).toBeUndefined();
    expect(scan.captures[2]?.station_known).toBe(false);
    expect(scan.captures[3]?.station_known).toBeUndefined();
  });

  it("reports unresolved fields and arguments with source locations, not values", () => {
    const root = fixture({
      "src/app.ts": [
        'client.capture({ event: "http", label: `Order ${privateId}` });',
        'client.capture({ event: category, label: "Checkout" });',
        'client.capture({ event: "redis" });',
        'client.capture(eventObject);',
        'client.capture([{ event: "s3", label: "Upload" }, ...events]);',
        'client.capture({ event: "http", label: "Fixed" } || eventObject);',
      ].join("\n"),
    });
    const scan = discoverCaptures(root);
    expect(scan.issues).toEqual([
      { file: "src/app.ts", line: 1, fields: ["label"] },
      { file: "src/app.ts", line: 2, fields: ["event"] },
      { file: "src/app.ts", line: 3, fields: ["label"] },
      { file: "src/app.ts", line: 4, fields: ["event", "label"] },
      { file: "src/app.ts", line: 5, fields: ["event", "label"] },
      { file: "src/app.ts", line: 6, fields: ["event", "label"] },
    ]);
    const output = formatCatalogIssues(scan);
    expect(output).toContain("src/app.ts:1: label missing or not a statically resolved string");
    expect(output).toContain("src/app.ts:2: event missing or not a statically resolved string");
    expect(output).not.toContain("privateId");
    expect(output).not.toContain("eventObject");
  });

  it("allows trailing call commas and flags oversized source as incomplete", () => {
    const source = SDK_BINDINGS + 'client.capture({ event: "http", label: "Checkout" },);';
    const root = fixture({
      "app.ts": source + " ".repeat(512 * 1024 - source.length),
      "too-large.ts": " ".repeat(512 * 1024 + 1),
    }, false);
    const scan = discoverCaptures(root);
    expect(scan.captures).toEqual([
      { event: "http", label: "Checkout", file: "app.ts", line: 1 },
    ]);
    expect(scan.issues).toEqual([]);
    expect(scan.truncated).toBe(true);
  });

  it("prints literal events and labels and skips non-static noise", () => {
    const root = fixture({
      "src/app.ts": `
        const hidden = "capture({ event: 'hidden', label: 'hidden' })";
        function recapture(value: string) {
          return value;
        }
        /* capture({ event: "commented", label: "nope" }) */
        // capture({ event: "commented", label: "line" })
        export function wire(trafficwar: TrafficWar, routeLabel: string) {
          trafficwar.capture({
            event: "http",
            label: "Checkout",
            properties: { event: "nested", label: "nested" },
          });
          trafficwar.capture([
            { event: "database", label: "Checkout", source: "db-primary" },
            { event: "redis", label: routeLabel },
          ]);
          trafficwar.capture({ event: "s3", label: \`Checkout\` });
          trafficwar.capture({
            event: "external" as const,
            label: \`pay-\${routeLabel}\`,
          });
          trafficwar.capture({ label: "Only label" });
        }
      `,
      "node_modules/other/ignored.ts": `
        client.capture({ event: "http", label: "Ignored" });
      `,
      "src/notes.md": `
        client.capture({ event: "http", label: "Not source" });
      `,
    });

    const scan = discoverCaptures(root);
    expect(scan.truncated).toBe(false);
    expect(scan.captures).toEqual([
      {
        event: "http",
        label: "Checkout",
        file: "src/app.ts",
        line: 9,
      },
      {
        event: "database",
        label: "Checkout",
        source: "db-primary",
        file: "src/app.ts",
        line: 15,
      },
      {
        event: "s3",
        label: "Checkout",
        file: "src/app.ts",
        line: 18,
      },
    ]);

    const printed = formatCaptureCatalog(scan);
    expect(printed).toContain("[TrafficWar] static captures (3)");
    expect(printed).toContain("http  Checkout  src/app.ts:9");
    expect(printed).not.toContain("redis");
    expect(printed).not.toContain("external");
    expect(printed).not.toContain("Only label");
    expect(printed).not.toContain("<dynamic>");
    expect(printed).not.toContain("<missing>");
    expect(printed).not.toContain("hidden");
    expect(printed).not.toContain("Ignored");
    expect(printed).not.toContain("nested");
  });

  it("does not report literals overridden by spreads or computed keys", () => {
    const root = fixture({
      "app.ts": `
        client.capture({ event: "http", label: "Overridden", ...runtime });
        client.capture({ event: "http", label: "Computed", [key]: value });
        client.capture({ ...runtime, event: "database", label: "Final" });
        client.capture({ event: "http", ...runtime, label: "Still unknown event" });
        client.capture({ event: "http", label: "Before", label: runtimeLabel });
        client.capture({ event: "redis", label: "Before", ["label"]: "After" });
      `,
    });
    expect(discoverCaptures(root).captures.map(({ event, label }) => [event, label])).toEqual([
      ["database", "Final"],
      ["redis", "After"],
    ]);
  });

  it("accepts simple type assertions but not expressions following them", () => {
    const root = fixture({
      "app.ts": `
        client.capture({ event: "http", label: "Prefix" as const + suffix });
        client.capture({ event: "http", label: "Prefix" satisfies string && runtime });
        client.capture({ event: "database" as\nconst, label: "Checkout" satisfies string });
      `,
    });
    expect(discoverCaptures(root).captures.map(({ event, label }) => [event, label])).toEqual([
      ["database", "Checkout"],
    ]);
  });

  it("decodes escaped literals and keeps control characters out of log lines", () => {
    const root = fixture({
      "app.ts": String.raw`
        client.capture({ event: "\x68tt\u0070", label: "Check\u006fut \u{1f680}" });
        client.capture({ event: "http", label: "Line\nTab\tEscape\u001b" });
      `,
    });
    const scan = discoverCaptures(root);
    expect(scan.captures.map(({ event, label }) => [event, label])).toEqual([
      ["http", "Checkout 🚀"],
      ["http", "Line\nTab\tEscape\u001b"],
    ]);
    const output = formatCaptureCatalog(scan);
    expect(output.split("\n")).toHaveLength(3);
    expect(output).toContain(String.raw`Line\nTab\tEscape\u001b`);
  });

  it("continues scanning siblings after encountering the depth limit", () => {
    const root = fixture({
      [`a/${"deep/".repeat(12)}app.ts`]: 'client.capture({ event: "http", label: "Too deep" });',
      "z/app.ts": 'client.capture({ event: "s3", label: "Sibling" });',
    });
    const scan = discoverCaptures(root);
    expect(scan.truncated).toBe(true);
    expect(scan.captures).toEqual([
      { event: "s3", label: "Sibling", file: "z/app.ts", line: 1 },
    ]);
  });

  it("reports an empty catalog without throwing", () => {
    const root = fixture({ "src/empty.ts": "export const ready = true;\n" });
    const scan = discoverCaptures(root);
    expect(scan.captures).toEqual([]);
    expect(formatCaptureCatalog(scan)).toBe(
      `[TrafficWar] no static capture() calls found under ${scan.root}`,
    );
  });

  it("resolves scoped constants, shorthand, enums, assertions, and relative reexports", () => {
    const root = fixture({
      "defs.ts": `export const identity = { event: "http", label: "Checkout" } as const;
        export const labels = { upload: "Upload" };
        export enum Category { Store = "s3" }`,
      "barrel.ts": 'export { identity as checkout, labels, Category } from "./defs.js";',
      "client.ts": 'import { TrafficWar as TW } from "@trafficwar/node"; export default new TW({ apiKey: "test" });',
      "app.ts": `import telemetry from "./client";
        import { checkout, labels, Category } from "./barrel";
        const event = "redis", label = "Cache";
        telemetry.capture(checkout);
        telemetry.capture({ event, label } satisfies Record<string, string>);
        telemetry.capture({ ...checkout, event: Category.Store, ["label"]: labels.upload });
        { const label = "Inner"; telemetry.capture({ event, label }); }
        const route = "Checkout";
        telemetry.capture({ event: "http", label: \`POST \${route}\` });
        telemetry.capture({ event: "http", label: "GET " + route });`,
    }, false);
    const scan = discoverCaptures(root);
    expect(scan.truncated).toBe(false);
    expect(scan.issues).toEqual([]);
    expect(scan.captures.map(({ event, label }) => [event, label])).toEqual([
      ["http", "Checkout"], ["redis", "Cache"], ["s3", "Upload"],
      ["redis", "Inner"], ["http", "POST Checkout"], ["http", "GET Checkout"],
    ]);
  });

  it("finds optional/bracket calls, bound aliases, captureBatch, and calls inside templates", () => {
    const root = fixture({ "app.ts": `
      client?.capture({ event: "http", label: "Optional receiver" });
      client.capture?.({ event: "database", label: "Optional call" });
      client["capture"]({ event: "redis", label: "Bracket" });
      const send = client.capture.bind(client);
      send({ event: "s3", label: "Bound" });
      client.captureBatch([{ event: "external", label: "Batch" }]);
      const text = \`result: \${client.capture({ event: "http", label: "Template call" })}\`;
      client.capture.call(client, { event: "http", label: "Call" });
      client.capture.apply(client, [{ event: "http", label: "Apply" }]);
    ` });
    const scan = discoverCaptures(root);
    expect(scan.issues).toEqual([]);
    expect(scan.captures.map(capture => capture.label)).toEqual([
      "Optional receiver", "Optional call", "Bracket", "Bound", "Batch", "Template call", "Call", "Apply",
    ]);
  });

  it("recognizes CommonJS namespaces and typed dependency-injected clients", () => {
    const root = fixture({
      "app.cjs": `const { TrafficWar: TW } = require("@trafficwar/node");
        const sdk = require("@trafficwar/node");
        const first = new TW({}); const second = new sdk.TrafficWar({});
        first.capture({event: "http", label: "First"});
        second.capture({event: "redis", label: "Second"});`,
      "service.ts": `import { TrafficWar } from "@trafficwar/node";
        class Service { constructor(private readonly telemetry: TrafficWar) {}
          send() { this.telemetry.capture({event: "database", label: "Injected"}); }
        }
        function send(telemetry: TrafficWar) { telemetry.capture({event: "s3", label: "Typed parameter"}); }
        const fromFactory: TrafficWar = opaqueFactory();
        fromFactory.capture({event:"http",label:"Typed factory"});
        class Local { telemetry = new TrafficWar({}); send() {this.telemetry.capture({event:"http",label:"Initialized field"});} }`,
    }, false);
    const scan = discoverCaptures(root);
    expect(scan.truncated).toBe(false);
    expect(scan.issues).toEqual([]);
    expect(scan.captures.map(capture => capture.label)).toEqual(["First", "Second", "Injected", "Typed parameter", "Typed factory", "Initialized field"]);
  });

  it("ignores other SDKs, shadowed names, conventional tests, regexes, and proven-dead code", () => {
    const root = fixture({
      "app.ts": `${SDK_BINDINGS}
        import other from "some-other-library";
        other.capture({event: user.category, label: user.id});
        function unrelated(client) { client.capture({event: dynamic, label: dynamic}); }
        if (ok) /client.capture({ event: "fake", label: "Regex" })/.test(text);
        if (false) client.capture({ event: "http", label: dynamic });
        false && client.capture({ event: "http", label: dynamic });
        true || client.capture({ event: "http", label: dynamic });
        while (false) client.capture({ event: "http", label: dynamic });
        function ended() { return; client.capture({ event: "http", label: dynamic }); }
        if (true) client.capture({event: "http", label: "Real"});
        else client.capture({ event: "http", label: dynamic });`,
      "app.test.ts": `${SDK_BINDINGS} client.capture({ event: dynamic, label: dynamic });`,
      "tests/helper.ts": `${SDK_BINDINGS} client.capture({ event: dynamic, label: dynamic });`,
      "__tests__/test.jsx": "this is deliberately invalid syntax !!!",
      "app.spec.js": "this is deliberately invalid syntax !!!",
    }, false);
    const scan = discoverCaptures(root);
    expect(scan.truncated).toBe(false);
    expect(scan.issues).toEqual([]);
    expect(scan.captures.map(({ event, label }) => [event, label])).toEqual([["http", "Real"]]);
  });

  it.each([
    'const identity = {event:"http", label:"Initial"}; identity.label = user.id;',
    'const identity = {event:"http", label:"Initial"}; const alias = identity; alias.label = user.id;',
    'const identity = {event:"http", label:"Initial"}; opaque(identity);',
    'const identity = {event:"http", label:"Initial"}; Object.assign(identity, {label: user.id});',
  ])("does not assume a const object is immutable: %s", declaration => {
    const scan = discoverCaptures(fixture({ "app.ts": `${declaration}\nclient.capture(identity);` }));
    expect(scan.captures).toEqual([]);
    expect(scan.issues).toEqual([{ file: "app.ts", line: 2, fields: ["event", "label"] }]);
  });

  it("still diagnoses runtime-controlled branches and fields at their capture locations", () => {
    const scan = discoverCaptures(fixture({ "app.ts": `
      if (process.env.PRODUCTION) client["capture"]({event: "http", label: user.id});
      const event = "http"; const label = process.env.ROUTE;
      client.capture({event, label});
    ` }));
    expect(scan.issues).toEqual([
      { file: "app.ts", line: 2, fields: ["label"] },
      { file: "app.ts", line: 4, fields: ["label"] },
    ]);
  });

  it("carries uncertainty through nested shared spreads and keeps array source locations", () => {
    const scan = discoverCaptures(fixture({ "app.ts": `
      const partial = {...runtime, label:"Partial"};
      client.capture({event:"http", ...partial});
      client.capture({...partial, event:"redis", label:"Final"});
      const batch = [{event:"database", label:"Select"}, {event:"s3", label:"Upload"}];
      client.capture([
        ...batch,
        {event:"external", label:"Payment"},
        ...dynamicBatch
      ]);
    ` }));
    expect(scan.captures.map(({ event, label, line }) => [event, label, line])).toEqual([
      ["redis", "Final", 4], ["database", "Select", 7], ["s3", "Upload", 7], ["external", "Payment", 8],
    ]);
    expect(scan.issues).toEqual([
      {file:"app.ts", line:3, fields:["event"]},
      {file:"app.ts", line:9, fields:["event", "label"]},
    ]);
  });

  it("detects mutation through assertions, nested aliases, array methods, and imported objects", () => {
    const scan = discoverCaptures(fixture({
      "defs.ts": 'export const shared = {event:"http", label:"Initial"};',
      "app.ts": `${SDK_BINDINGS}
        import {shared} from "./defs"; shared.label = user.id; client.capture(shared);
        const nested = {identity:{event:"http", label:"Nested"}};
        const alias = nested.identity as const; alias.label = user.id; client.capture(nested.identity);
        const batch = [{event:"http",label:"Batch"}]; batch.push(dynamic); client.capture(batch);`,
    }, false));
    expect(scan.captures).toEqual([]);
    expect(scan.issues).toEqual([2,4,5].map(line => ({file:"app.ts",line,fields:["event","label"]})));
  });

  it("does not confuse hoisted functions with statements after return", () => {
    const scan = discoverCaptures(fixture({ "app.ts": `
      function run() {
        hoisted(); return;
        function hoisted() { client.capture({event:"http",label:"Hoisted"}); }
        client.capture({event:"http",label:dynamic});
      }
    ` }));
    expect(scan.issues).toEqual([]);
    expect(scan.captures.map(capture => capture.label)).toEqual(["Hoisted"]);
  });

  it("terminates cyclic imports without executing either module", () => {
    const scan = discoverCaptures(fixture({
      "a.ts": 'export {label} from "./b"; throw new Error("must not run");',
      "b.ts": 'export {label} from "./a";',
      "app.ts": `${SDK_BINDINGS} import {label} from "./a"; client.capture({event:"http",label});`,
    }, false));
    expect(scan.captures).toEqual([]);
    expect(scan.issues).toEqual([{file:"app.ts",line:1,fields:["label"]}]);
  });

  it("enforces the total source budget inclusively", () => {
    const files: Record<string, string> = Object.fromEntries(Array.from({length:33}, (_, i) => [`a${String(i).padStart(2,"0")}.ts`, " ".repeat(512 * 1024)]));
    for (const [file, label] of [["a31.ts", "Last accepted"], ["a32.ts", "Over budget"]]) {
      const source = SDK_BINDINGS + `client.capture({event:"http",label:"${label}"});`;
      files[file!] = source + " ".repeat(512 * 1024 - source.length);
    }
    const scan = discoverCaptures(fixture(files, false));
    expect(scan.truncated).toBe(true);
    expect(scan.captures.map(capture => capture.label)).toEqual(["Last accepted"]);
  });

  it("fails closed on parse errors and unresolved local imports without hiding valid siblings", () => {
    const scan = discoverCaptures(fixture({
      "app.ts": 'import { label } from "./missing"; client.capture({event:"http", label});',
      "broken.ts": "const = !!!",
      "valid.ts": 'client.capture({event:"http", label:"Valid"});',
    }));
    expect(scan.truncated).toBe(true);
    expect(scan.captures.map(capture => capture.label)).toEqual(["Valid"]);
    expect(scan.issues).toEqual([
      { file: "app.ts", line: 1, fields: ["label"] },
      { file: "broken.ts", line: 1, fields: ["unparseable source"] },
    ]);
  });
});
