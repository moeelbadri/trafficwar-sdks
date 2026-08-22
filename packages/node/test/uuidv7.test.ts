import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "../src/uuidv7";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uuidv7", () => {
  it("sets RFC 9562 version and variant bits", () => {
    const value = uuidv7();

    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is unique and process-monotonic with a stalled or backward clock", () => {
    const logicalNow = Date.now() + 10_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(logicalNow)
      .mockReturnValueOnce(logicalNow)
      .mockReturnValueOnce(logicalNow - 5_000);

    const values = [uuidv7(), uuidv7(), uuidv7()];

    expect(new Set(values)).toHaveLength(values.length);
    expect(values).toEqual([...values].sort());
    expect(
      values.map((value) =>
        Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16),
      ),
    ).toEqual([logicalNow, logicalNow, logicalNow]);
  });
});
