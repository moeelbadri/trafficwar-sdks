import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { discoverCaptures, formatCaptureCatalog } from "../src/catalog";

const directories: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "trafficwar-scan-"));
  directories.push(root);
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("discoverCaptures", () => {
  it("prints literal events and labels and skips non-static noise", () => {
    const root = fixture({
      "src/app.ts": `
        const hidden = "capture({ event: 'hidden', label: 'hidden' })";
        function recapture(value: string) {
          return value;
        }
        /* capture({ event: "commented", label: "nope" }) */
        // capture({ event: "commented", label: "line" })
        export function wire(trafficwar, routeLabel: string) {
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
        file: "src/app.ts",
        line: 15,
      },
      {
        event: "redis",
        label: "<dynamic>",
        file: "src/app.ts",
        line: 16,
      },
      {
        event: "s3",
        label: "Checkout",
        file: "src/app.ts",
        line: 18,
      },
      {
        event: "external",
        label: "<dynamic>",
        file: "src/app.ts",
        line: 19,
      },
      {
        event: "<missing>",
        label: "Only label",
        file: "src/app.ts",
        line: 23,
      },
    ]);

    const printed = formatCaptureCatalog(scan);
    expect(printed).toContain("[TrafficWar] static captures (6)");
    expect(printed).toContain("http  Checkout  src/app.ts:9");
    expect(printed).not.toContain("hidden");
    expect(printed).not.toContain("Ignored");
    expect(printed).not.toContain("nested");
  });

  it("reports an empty catalog without throwing", () => {
    const root = fixture({ "src/empty.ts": "export const ready = true;\n" });
    const scan = discoverCaptures(root);
    expect(scan.captures).toEqual([]);
    expect(formatCaptureCatalog(scan)).toBe(
      `[TrafficWar] no static capture() calls found under ${scan.root}`,
    );
  });
});
