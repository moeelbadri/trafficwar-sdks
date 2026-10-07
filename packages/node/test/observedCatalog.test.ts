import { afterEach, describe, expect, it, vi } from "vitest";
import { TrafficWar, TrafficWarValidationError } from "../src";
import type { TrafficWarEvent, TrafficWarOptions } from "../src";
import { ObservedCatalog, type CatalogPair } from "../src/observedCatalog";

const pair = (event: string, label: string): CatalogPair => ({ event, label, station_known: false });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); });

function client(options: Partial<TrafficWarOptions> = {}) {
  const posts: CatalogPair[][] = [];
  const events: TrafficWarEvent[] = [];
  const onError = vi.fn();
  const sdk = new TrafficWar({
    apiKey: "test-secret", compression: "none", maxRetries: 0,
    flushIntervalMs: 60_000, onError,
    fetch: async (url, init) => {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-secret");
      if (url.endsWith("/catalog")) {
        const captures = JSON.parse(String(init.body)).captures as CatalogPair[];
        posts.push(captures);
        return response({ status: "ok", added: captures.length });
      }
      const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as TrafficWarEvent[];
      events.push(...batch);
      return response({ status: "ok", accepted: batch.length, ingest_id: "observed" });
    }, ...options,
  });
  return { sdk, posts, events, onError };
}

describe("observed catalog memory", () => {
  it("coalesces a fixed second from first discovery, not a resetting debounce", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_pairs: CatalogPair[]) => undefined);
    const catalog = new ObservedCatalog(send, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).not.toHaveBeenCalled();
    catalog.observe([{ event: "http", label: "First" }]);
    await vi.advanceTimersByTimeAsync(900);
    catalog.observe([{ event: "database", label: "Second" }]);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledExactlyOnceWith([pair("http", "First"), pair("database", "Second")]);
    catalog.observe([{ event: "http", label: "First" }]);
    await vi.advanceTimersByTimeAsync(5000);
    await catalog.close();
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates exact pairs without delimiter/cross-product/whitespace collisions", async () => {
    const send = vi.fn(async (_pairs: CatalogPair[]) => undefined);
    const catalog = new ObservedCatalog(send, vi.fn());
    const identities = [
      pair("ab", "c"), pair("a", "bc"), pair("a:b", "c"), pair("a", "b:c"),
      pair('a","b', "c"), pair("a", 'b","c'), pair("http", "Home"),
      pair("HTTP", "Home"), pair("http", " Home "), pair("database", "Home"),
    ];
    catalog.observe([...identities, ...identities]);
    await catalog.flush();
    expect(send).toHaveBeenCalledExactlyOnceWith(identities);
    catalog.observe(identities);
    await catalog.close();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serializes in-flight work, joins flushes and sends only later deltas", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const send = vi.fn(async (_pairs: CatalogPair[]): Promise<void> => undefined)
      .mockImplementationOnce(() => gate.promise);
    const catalog = new ObservedCatalog(send, vi.fn());
    catalog.observe([{ event: "http", label: "One" }]);
    const flushing = catalog.flush();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) {
      catalog.observe([{ event: "http", label: "One" }, { event: "redis", label: "Two" }]);
      expect(catalog.flush()).toBe(flushing);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flushing;
    expect(send.mock.calls.map(([pairs]) => pairs)).toEqual([[pair("http", "One")], [pair("redis", "Two")]]);
    await catalog.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains failures, cannot bypass cooldown, retries without further traffic", async () => {
    vi.useFakeTimers();
    const report = vi.fn(() => { throw new Error("broken callback"); });
    const send = vi.fn(async (_pairs: CatalogPair[]) => undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const catalog = new ObservedCatalog(send, report);
    catalog.observe([{ event: "http", label: "One" }]);
    await catalog.flush();
    expect(report).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) {
      catalog.observe([{ event: "http", label: "One" }]);
      await catalog.flush();
    }
    catalog.observe([{ event: "redis", label: "Two" }]);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(([pairs]) => pairs)).toEqual([
      [pair("http", "One")], [pair("http", "One"), pair("redis", "Two")],
    ]);
    await catalog.close();
  });

  it("coalesces discoveries during background HTTP instead of POSTing once per new capture", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const send = vi.fn(async (_pairs: CatalogPair[]): Promise<void> => undefined)
      .mockImplementationOnce(() => gate.promise);
    const catalog = new ObservedCatalog(send, vi.fn());
    catalog.observe([{ event: "http", label: "One" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    catalog.observe([{ event: "redis", label: "Two" }]);
    await vi.advanceTimersByTimeAsync(100);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(899);
    catalog.observe([{ event: "s3", label: "Three" }]);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls[1]![0]).toEqual([pair("redis", "Two"), pair("s3", "Three")]);
    await catalog.close();
  });

  it("bounds cooldowns at 30 seconds and stops automatic retries on close", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error("permanent error"); });
    const catalog = new ObservedCatalog(send, vi.fn());
    catalog.observe([{ event: "http", label: "Home" }]);
    await catalog.flush();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = send.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(send).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(before + 1);
    }
    await catalog.close();
    const before = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await catalog.flush();
    await catalog.close();
    expect(send).toHaveBeenCalledTimes(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("chunks unsent deltas without restricting valid captures", async () => {
    const send = vi.fn(async (_pairs: CatalogPair[]) => undefined);
    const catalog = new ObservedCatalog(send, vi.fn());
    catalog.observe(Array.from({ length: 4001 }, (_, i) => ({ event: "http", label: `Route ${i}` })));
    await catalog.close();
    expect(send.mock.calls.map(([pairs]) => pairs.length)).toEqual([4000, 1]);
  });
});

describe("observed capture integration", () => {
  it("never rewrites dynamic values at one wrapper site and snapshots both events and pairs", async () => {
    const { sdk, events, posts } = client();
    const work = (input: TrafficWarEvent) => sdk.capture(input);
    expect(posts).toEqual([]);
    const first = { event: "database", label: "Checkout", properties: { secret: "private" }, source: "db", span_kind: "client" as const };
    work(first);
    first.label = "Mutation";
    first.properties.secret = "changed";
    work({ event: "redis", label: "Different" });
    sdk.captureBatch([{ event: "s3", label: "Upload" }, { event: "http", label: "Home" }]);
    sdk.captureBatch([{ event: "http", label: "Home" }, { event: "s3", label: "Upload" }]);
    expect((await sdk.flush()).accepted).toBe(6);
    expect(events.map(e => [e.event, e.label])).toEqual([
      ["database", "Checkout"], ["redis", "Different"], ["s3", "Upload"], ["http", "Home"], ["http", "Home"], ["s3", "Upload"],
    ]);
    expect(events[0]!.properties).toEqual({ secret: "private" });
    expect(posts).toEqual([[pair("database", "Checkout"), pair("redis", "Different"), pair("s3", "Upload"), pair("http", "Home")]]);
    work({ event: "database", label: "Checkout" });
    work({ event: "external", label: "Delta" });
    await sdk.close();
    expect(posts[1]).toEqual([pair("external", "Delta")]);
  });

  it("accepts missing/catalog-invalid strings unchanged but registers no malformed identity", async () => {
    const { sdk, posts, events } = client();
    const invalidLabels = [undefined, "", "   ", "Home\n", "Home\u0085", "x".repeat(129)];
    for (const label of invalidLabels) sdk.capture({ event: "http", ...(label === undefined ? {} : { label }) });
    sdk.capture({ event: "e".repeat(129), label: "Long event" });
    sdk.capture({ event: "http\n", label: "Control event" });
    sdk.capture({ event: "😀".repeat(128), label: "😀".repeat(128) });
    expect((await sdk.close()).accepted).toBe(9);
    expect(events.slice(0, 6).map(e => e.label)).toEqual(invalidLabels);
    expect(posts).toEqual([[pair("😀".repeat(128), "😀".repeat(128))]]);
  });

  it("never learns rejected batches, duplicate IDs, sparse arrays or full queues", async () => {
    const { sdk, posts } = client({ maxQueueSize: 2 });
    const id = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    expect(() => sdk.capture([{ event: "http", label: "Poison" }, { event: "redis", label: "Bad", latency_ms: NaN }])).toThrow(TrafficWarValidationError);
    expect(() => sdk.capture([{ event: "http", label: "Poison", event_id: id }, { event: "http", label: "Duplicate", event_id: id }])).toThrow(/duplicates/);
    expect(() => sdk.capture(new Array(1))).toThrow(/sparse/);
    sdk.capture({ event: "http", label: "Good", event_id: id });
    expect(() => sdk.capture({ event: "redis", label: "Poison", event_id: id })).toThrow(/duplicates/);
    sdk.capture({ event: "database", label: "Query" });
    expect(() => sdk.capture({ event: "s3", label: "Overflow" })).toThrow(/queue/);
    expect((await sdk.close()).accepted).toBe(2);
    expect(posts).toEqual([[pair("http", "Good"), pair("database", "Query")]]);
  });

  it("flush/close join in-flight catalog HTTP without duplicate POSTs or blocking event transport", async () => {
    const gate = deferred<Response>();
    const started = deferred<void>();
    let posts = 0, delivered = 0;
    const { sdk } = client({ fetch: async (url, init) => {
      if (url.endsWith("/catalog")) { posts++; started.resolve(); return gate.promise; }
      const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
      delivered += batch.length;
      return response({ status: "ok", accepted: batch.length, ingest_id: "lifecycle" });
    } });
    sdk.capture({ event: "http", label: "Home" });
    let finished = false;
    const flushing = sdk.flush().then(result => { finished = true; return result; });
    await started.promise;
    const joins = Array.from({ length: 20 }, () => sdk.flush());
    const closing = sdk.close();
    expect(sdk.close()).toBe(closing);
    expect(sdk.flush()).toBe(closing);
    expect(delivered).toBe(1);
    expect(finished).toBe(false);
    expect(posts).toBe(1);
    expect(() => sdk.capture({ event: "http", label: "Too late" })).toThrow(/closing/);
    gate.resolve(response({ status: "ok", added: 1 }));
    await Promise.all([flushing, closing, ...joins]);
    expect(posts).toBe(1);
    expect(() => sdk.capture({ event: "http" })).toThrow(/closed/);
  });

  it.each(["throw", "reject"])("safely handles %s from onError and retains HTTP failures", async mode => {
    vi.useFakeTimers();
    let catalogCalls = 0;
    const onError = vi.fn(() => {
      if (mode === "throw") throw new Error("callback");
      return Promise.reject(new Error("callback"));
    });
    const bodies: unknown[] = [];
    const { sdk } = client({ onError, fetch: async (url, init) => {
      if (url.endsWith("/catalog")) {
        bodies.push(JSON.parse(String(init.body)));
        return ++catalogCalls === 1 ? response({ status: "error", error: "offline" }, 503) : response({ status: "ok", added: 1 });
      }
      const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
      return response({ status: "ok", accepted: batch.length, ingest_id: "safe-error" });
    } });
    sdk.capture({ event: "http", label: "Home" });
    expect((await sdk.flush()).accepted).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) await sdk.flush();
    expect(catalogCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(catalogCalls).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await sdk.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses bounded HTTP retries and never marks invalid successes sent", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const { sdk, onError } = client({ maxRetries: 1, fetch: async (url, init) => {
      if (url.endsWith("/catalog")) {
        calls++;
        if (calls === 1) return response({ status: "error", error: "offline" }, 503);
        if (calls === 2) return response({ status: "ok", added: 2 });
        return response({ status: "ok", added: 0 });
      }
      const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
      return response({ status: "ok", accepted: batch.length, ingest_id: "retry" });
    } });
    sdk.capture({ event: "http", label: "Home" });
    await sdk.flush();
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);
    sdk.capture({ event: "http", label: "Home" });
    await sdk.close();
    expect(calls).toBe(3);
  });

  it("keeps sent memory after server deletion but a fresh client registers again", async () => {
    const first = client();
    first.sdk.capture({ event: "http", label: "Home" });
    await first.sdk.flush();
    first.posts.length = 0; // Model clearing server-side catalog state.
    first.sdk.capture({ event: "http", label: "Home" });
    await first.sdk.close();
    expect(first.posts).toEqual([]);
    const fresh = client();
    expect(fresh.posts).toEqual([]);
    fresh.sdk.capture({ event: "http", label: "Home" });
    await fresh.sdk.close();
    expect(fresh.posts).toEqual([[pair("http", "Home")]]);
  });

  it("catalog failures cannot break close, and event failures remain recoverable", async () => {
    let failEvent = true;
    const { sdk, onError } = client({ fetch: async (url, init) => {
      if (url.endsWith("/catalog")) return response({ status: "error", error: "catalog unavailable" }, 503);
      if (failEvent) return response({ status: "error", error: "event unavailable" }, 503);
      const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
      return response({ status: "ok", accepted: batch.length, ingest_id: "recovered" });
    } });
    sdk.capture({ event: "http", label: "Home" });
    await expect(sdk.close()).rejects.toThrow("event unavailable");
    expect(onError).toHaveBeenCalledTimes(1);
    failEvent = false;
    expect((await sdk.close()).accepted).toBe(1);
    expect((await sdk.close()).accepted).toBe(0);
  });
});
