interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  message: { maxRequests: 60, windowMs: 60_000 },
  agent_spawn: { maxRequests: 10, windowMs: 3_600_000 },
  task_create: { maxRequests: 100, windowMs: 3_600_000 },
  // Per-token budget for external MCP agents hitting POST /mcp.
  mcp: { maxRequests: 120, windowMs: 60_000 },
  // "Re-check providers" (cyborg:refresh_providers): each call runs the FULL
  // provider probe suite on the daemon host (CLI handshakes, pi RPC session).
  // The UI single-flights it, but a raw client could spam it — keep it humane.
  provider_recheck: { maxRequests: 6, windowMs: 60_000 },
  // Tasks Phase 2 — per-channel watcher debounce. The channel watcher fires on
  // un-mentioned human chatter, so each turn spawns an (LLM) ephemeral cybo. Cap
  // it to ≤1 watcher turn per channel per 20s for cost control (internal docs
  // §2.2/2.3). Keyed by channel id.
  agent_watch: { maxRequests: 1, windowMs: 20_000 },
};

// How often (at most) check() amortizes a full sweep of empty/expired buckets.
const SWEEP_INTERVAL_MS = 5 * 60_000;

interface Bucket {
  hits: number[];
  windowMs: number;
}

export class RateLimiter {
  private windows = new Map<string, Bucket>();
  private lastSweep = 0;

  check(
    key: string,
    action: string,
    overrides?: Partial<Record<string, RateLimitConfig>>,
  ): { allowed: boolean; retryAfterMs?: number } {
    const config = overrides?.[action] ?? DEFAULT_LIMITS[action];
    if (!config) return { allowed: true };

    const windowKey = `${action}:${key}`;
    const now = Date.now();
    const cutoff = now - config.windowMs;

    // Amortized GC: without it, every distinct (action, key) that ever called
    // check() leaks a bucket forever (only reset()/clear() removed entries).
    // Piggyback on check traffic instead of holding a timer.
    this.maybeSweep(now);

    let bucket = this.windows.get(windowKey);
    if (!bucket) {
      bucket = { hits: [], windowMs: config.windowMs };
      this.windows.set(windowKey, bucket);
    } else {
      // Keep the window current if an override changed it for this action.
      bucket.windowMs = config.windowMs;
    }
    const timestamps = bucket.hits;

    // Prune expired entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= config.maxRequests) {
      const retryAfterMs = timestamps[0] + config.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  // Drop fully-expired buckets (and prune partially-expired ones) so inactive
  // keys don't accumulate. Bounded work — runs at most once per interval.
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    this.sweep(now);
  }

  // Exposed for tests/manual GC. Removes any bucket with no live timestamps.
  sweep(now: number = Date.now()): void {
    for (const [windowKey, bucket] of this.windows) {
      const cutoff = now - bucket.windowMs;
      while (bucket.hits.length > 0 && bucket.hits[0] < cutoff) {
        bucket.hits.shift();
      }
      if (bucket.hits.length === 0) this.windows.delete(windowKey);
    }
  }

  // Number of tracked buckets — for tests/observability.
  size(): number {
    return this.windows.size;
  }

  reset(key: string, action: string): void {
    this.windows.delete(`${action}:${key}`);
  }

  clear(): void {
    this.windows.clear();
  }
}
