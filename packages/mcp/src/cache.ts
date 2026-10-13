/**
 * One value per key for `ttlMs`. Callers asking while a load runs share it,
 * and when a refresh fails the last good value is served, marked stale.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return { value: hit.value, stale: false };

    let running = this.pending.get(key);
    if (!running) {
      running = load().finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    try {
      const value = await running;
      this.remember(key, value);
      return { value, stale: false };
    } catch (error) {
      if (hit) return { value: hit.value, stale: true };
      throw error;
    }
  }

  private remember(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
