export interface CatalogPair {
  event: string;
  label: string;
  station_known: false;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && [...value].length <= 128 && !/\p{Cc}/u.test(value);
}

/** Per-client memory only. A failed upload never becomes a sent identity. */
export class ObservedCatalog {
  readonly #pairs = new Map<string, { pair: CatalogPair; sent: boolean }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #upload: Promise<void> | undefined;
  #windowAt = 0;
  #force = false;
  #retryAt = 0;
  #failures = 0;
  #closed = false;

  constructor(
    readonly send: (pairs: CatalogPair[]) => Promise<void>,
    readonly report: (error: unknown) => void,
    readonly verbose = false,
  ) {}

  observe(events: readonly { event: string; label?: unknown }[]): void {
    for (const event of events) {
      if (!validIdentity(event.event) || !validIdentity(event.label)) continue;
      const key = JSON.stringify([event.event, event.label]);
      if (this.#pairs.has(key)) continue;
      this.#pairs.set(key, {
        pair: { event: event.event, label: event.label, station_known: false },
        sent: false,
      });
      if (this.#windowAt === 0) this.#windowAt = Date.now() + 1000;
      this.#schedule();
    }
  }

  #pending(): boolean {
    return [...this.#pairs.values()].some(entry => !entry.sent);
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined || this.#upload) return;
    // Fixed window: subsequent discoveries do not reset the deadline.
    const delay = Math.max(0, this.#windowAt - Date.now(), this.#retryAt - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush(false);
    }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  flush(): Promise<void> {
    if (this.#closed) return this.#upload ?? Promise.resolve();
    return this.#flush(true);
  }

  #flush(force: boolean): Promise<void> {
    if (this.#upload) {
      this.#force ||= force;
      return this.#upload;
    }
    if (!this.#pending() || Date.now() < this.#retryAt) return Promise.resolve();
    this.#force = force;
    this.#clearTimer();
    // Publish the promise before invoking user-provided transport/report hooks.
    const upload = Promise.resolve().then(async () => {
      while (this.#pending() && (this.#force || Date.now() >= this.#windowAt)) {
        // Snapshot this window once. New discoveries during HTTP get their own
        // fixed window; background traffic cannot turn into one POST per pair.
        const snapshot = [...this.#pairs.values()].filter(entry => !entry.sent);
        this.#windowAt = 0;
        try {
          for (let offset = 0; offset < snapshot.length; offset += 4000) {
            const entries = snapshot.slice(offset, offset + 4000);
            await this.send(entries.map(entry => entry.pair));
            for (const entry of entries) entry.sent = true;
            this.#failures = 0;
            this.#retryAt = 0;
            if (this.verbose) {
              for (const { pair } of entries) {
                try { console.info(`[TrafficWar] registered pair ${JSON.stringify(pair.event)} ${JSON.stringify(pair.label)}`); }
                catch { /* Diagnostics must never affect delivery. */ }
              }
            }
          }
        } catch (error) {
          // Transport already has bounded retries. Subsequent cycles back off
          // from 1 s to 30 s; captures and manual flushes cannot bypass this.
          this.#retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.#failures++, 5));
          try { this.report(error); } catch { /* Error handlers are advisory. */ }
          break;
        }
      }
    }).finally(() => {
      this.#upload = undefined;
      this.#force = false;
      if (this.#pending()) this.#schedule();
    });
    this.#upload = upload;
    return upload;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#upload;
      return;
    }
    this.#closed = true;
    this.#clearTimer();
    await this.#flush(true);
  }
}
