import { describe, it, expect } from "vitest";
import { createConcurrencyLimiter } from "./concurrency-limiter.js";

describe("createConcurrencyLimiter", () => {
  it("admits up to maxConcurrent immediately and queues the rest", async () => {
    const lim = createConcurrencyLimiter(2, 10);
    expect(await lim.acquire()).toBe(true);
    expect(await lim.acquire()).toBe(true);
    expect(lim.active).toBe(2);

    let third = false;
    const p = lim.acquire().then((ok) => (third = ok));
    await Promise.resolve();
    expect(third).toBe(false); // still queued
    expect(lim.queued).toBe(1);

    lim.release(); // hand the slot to the waiter
    expect(await p).toBe(true);
    expect(lim.active).toBe(2); // stayed at the cap (handoff, no dip)
    expect(lim.queued).toBe(0);
  });

  it("sheds load (returns false) once the queue is full", async () => {
    const lim = createConcurrencyLimiter(1, 1);
    expect(await lim.acquire()).toBe(true); // active
    const queued = lim.acquire(); // fills the single queue slot
    await Promise.resolve();
    expect(lim.queued).toBe(1);
    expect(await lim.acquire()).toBe(false); // queue full → shed

    lim.release();
    expect(await queued).toBe(true);
  });

  it("decrements active when nobody is waiting", async () => {
    const lim = createConcurrencyLimiter(2);
    await lim.acquire();
    await lim.acquire();
    expect(lim.active).toBe(2);
    lim.release();
    expect(lim.active).toBe(1);
    lim.release();
    expect(lim.active).toBe(0);
  });

  it("returns false immediately for an already-aborted signal", async () => {
    const lim = createConcurrencyLimiter(2);
    const ac = new AbortController();
    ac.abort();
    expect(await lim.acquire(ac.signal)).toBe(false);
    expect(lim.active).toBe(0); // never admitted, nothing to release
  });

  it("drops a queued waiter (resolve false, remove from queue) when its signal aborts", async () => {
    const lim = createConcurrencyLimiter(1, 10);
    expect(await lim.acquire()).toBe(true); // hold the only slot
    const ac = new AbortController();
    let resolved: boolean | undefined;
    const p = lim.acquire(ac.signal).then((ok) => (resolved = ok));
    await Promise.resolve();
    expect(lim.queued).toBe(1);

    ac.abort();
    expect(await p).toBe(false);
    expect(resolved).toBe(false);
    expect(lim.queued).toBe(0); // removed from the queue

    // The original slot's release should NOT grant the (gone) aborted waiter.
    lim.release();
    expect(lim.active).toBe(0);
  });

  it("never lets active exceed maxConcurrent under a burst", async () => {
    const lim = createConcurrencyLimiter(3, 100);
    const results = await Promise.all(Array.from({ length: 3 }, () => lim.acquire()));
    expect(results).toEqual([true, true, true]);
    expect(lim.active).toBe(3);
    // 5 more all queue (none admitted)
    for (let i = 0; i < 5; i++) void lim.acquire();
    await Promise.resolve();
    expect(lim.active).toBe(3);
    expect(lim.queued).toBe(5);
  });
});
