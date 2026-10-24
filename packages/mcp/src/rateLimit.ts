/**
 * Bounds how fast a client can change the vault: at most `max` mutating tool calls in any `windowMs`. A client that
 * is compromised or stuck in a loop then cannot rewrite or trash a whole vault in seconds. Reads are not limited.
 *
 * The server builds a fresh MCP server per request, so one limiter is created with the app and shared by all of them.
 * There is a single API key, so the limit is for the whole server, not per client.
 */
export class WriteLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one write. Returns null when it may go ahead, otherwise how many seconds until a slot frees up. */
  take(): number | null {
    if (this.max <= 0) return null;
    const now = this.now();
    while (this.stamps.length && this.stamps[0]! <= now - this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.max) return Math.max(1, Math.ceil((this.stamps[0]! + this.windowMs - now) / 1000));
    this.stamps.push(now);
    return null;
  }
}
