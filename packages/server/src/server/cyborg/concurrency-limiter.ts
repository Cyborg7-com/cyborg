// Minimal in-process async concurrency limiter (no deps). Bounds how many
// expensive jobs run at once and sheds load past a queue cap instead of queueing
// unboundedly. Used to cap CPU/RAM-heavy work like sharp thumbnailing (#196):
// each in-flight job holds a full source buffer and sharp is CPU-bound, so
// unbounded concurrency can pin the relay.
//
//   const limiter = createConcurrencyLimiter(6, 100);
//   if (!(await limiter.acquire())) return busy503();
//   try { ...work... } finally { limiter.release(); }

export interface ConcurrencyLimiter {
  // Resolves true once a slot is held; false if the queue is full (shed load) or
  // the optional signal aborts while queued (e.g. the client disconnected — drop
  // the waiter instead of doing the expensive work anyway). Each true result MUST
  // be paired with exactly one release(); a false result must NOT call release().
  acquire(signal?: AbortSignal): Promise<boolean>;
  release(): void;
  readonly active: number;
  readonly queued: number;
}

export function createConcurrencyLimiter(
  maxConcurrent: number,
  maxQueue = Number.POSITIVE_INFINITY,
): ConcurrencyLimiter {
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    acquire(signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return Promise.resolve(false);
      if (active < maxConcurrent) {
        active += 1;
        return Promise.resolve(true);
      }
      if (waiters.length >= maxQueue) {
        return Promise.resolve(false);
      }
      // Slot ownership is handed directly from release() to this waiter, so
      // `active` stays at maxConcurrent (never decremented then re-incremented).
      // If `signal` aborts while queued, drop the waiter and resolve false so a
      // disconnected client doesn't tie up (or later execute on) a slot.
      return new Promise<boolean>((resolve) => {
        function onAbort(): void {
          const idx = waiters.indexOf(grant);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(false);
        }
        function grant(): void {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(grant);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next();
      } else {
        active = Math.max(0, active - 1);
      }
    },
    get active() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
  };
}
