import { Redis } from "ioredis";
import type { Logger } from "pino";

export class RelayRedis {
  private redis: Redis;
  private sub: Redis | null = null;
  private readonly url: string;
  private readonly prefix: string;
  // Route client errors to the pino sink (#736) instead of console; null when the
  // caller omits it (tests).
  private readonly logger: Logger | null;

  constructor(url: string, prefix = "cyborg:relay:", logger?: Logger) {
    this.url = url;
    this.logger = logger ?? null;
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    // An unhandled "error" event on an ioredis client throws and can crash the
    // process. ioredis auto-reconnects by default; we just need to keep the
    // event handled and logged.
    this.redis.on("error", (err: Error) => {
      this.logger?.error({ err }, "[redis] client error");
    });
    this.prefix = prefix;
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  // ─── Daemon Presence ──────────────────────────────────────────────

  async setDaemonOnline(
    daemonId: string,
    meta: Record<string, unknown>,
    ttlSecs = 90,
  ): Promise<void> {
    const key = `${this.prefix}daemon:${daemonId}`;
    await this.redis.set(key, JSON.stringify({ ...meta, ts: Date.now() }), "EX", ttlSecs);
  }

  async isDaemonOnline(daemonId: string): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}daemon:${daemonId}`)) === 1;
  }

  async getOnlineDaemons(): Promise<string[]> {
    const keys = await this.redis.keys(`${this.prefix}daemon:*`);
    return keys.map((k: string) => k.replace(`${this.prefix}daemon:`, ""));
  }

  async removeDaemon(daemonId: string): Promise<void> {
    await this.redis.del(`${this.prefix}daemon:${daemonId}`);
  }

  // ─── Rate Limiting ─────────────────────────────────────────────────

  async checkRate(identifier: string, maxPerWindow: number, windowSecs: number): Promise<boolean> {
    const key = `${this.prefix}rate:${identifier}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSecs);
    }
    return count <= maxPerWindow;
  }

  // ─── Write-Ahead Buffer (PG failure fallback) ──────────────────────

  async bufferMessage(workspaceId: string, message: Record<string, unknown>): Promise<void> {
    const key = `${this.prefix}pgbuf:${workspaceId}`;
    await this.redis.rpush(key, JSON.stringify(message));
    await this.redis.expire(key, 3600);
  }

  async drainBufferedMessages(
    workspaceId: string,
    count = 100,
  ): Promise<Record<string, unknown>[]> {
    const key = `${this.prefix}pgbuf:${workspaceId}`;
    const items = await this.redis.lrange(key, 0, count - 1);
    if (items.length > 0) {
      await this.redis.ltrim(key, items.length, -1);
    }
    return items.map((s: string) => JSON.parse(s) as Record<string, unknown>);
  }

  async getBufferedWorkspaces(): Promise<string[]> {
    const keys = await this.redis.keys(`${this.prefix}pgbuf:*`);
    return keys.map((k: string) => k.replace(`${this.prefix}pgbuf:`, ""));
  }

  // ─── Pub/Sub for cross-instance broadcast fanout ───────────────────

  async publish(channel: string, message: Record<string, unknown>): Promise<void> {
    await this.redis.publish(`${this.prefix}${channel}`, JSON.stringify(message));
  }

  /**
   * Publish a guest broadcast so other relay instances can deliver it to the
   * guests they hold. `originId` lets the publishing instance ignore its own
   * message on the subscriber side (it already delivered locally).
   */
  async publishBroadcast(payload: {
    originId: string;
    workspaceId: string;
    message: Record<string, unknown>;
    seq?: number;
  }): Promise<void> {
    await this.redis.publish(`${this.prefix}broadcast`, JSON.stringify(payload));
  }

  /**
   * Subscribe to cross-instance broadcasts on a dedicated connection (ioredis
   * requires a separate client for subscriber mode).
   */
  async subscribeBroadcast(
    handler: (payload: {
      originId: string;
      workspaceId: string;
      message: Record<string, unknown>;
      seq?: number;
    }) => void,
  ): Promise<void> {
    // Close any prior subscriber to avoid leaking connections on repeat calls.
    // intentional: best-effort teardown of a connection we're discarding anyway.
    if (this.sub) await this.sub.quit().catch(() => {});
    this.sub = new Redis(this.url, { maxRetriesPerRequest: null });
    this.sub.on("error", (err: Error) => {
      this.logger?.error({ err }, "[redis-sub] client error");
    });
    // Register the message listener BEFORE subscribing so no message published
    // in the window right after subscribe succeeds is dropped.
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw));
      } catch {
        // ignore malformed payloads
      }
    });
    await this.sub.subscribe(`${this.prefix}broadcast`);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────

  async close(): Promise<void> {
    // intentional: best-effort teardown — we're shutting down the client anyway.
    if (this.sub) await this.sub.quit().catch(() => {});
    await this.redis.quit();
  }
}
