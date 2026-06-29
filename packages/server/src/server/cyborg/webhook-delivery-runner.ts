import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { DueWebhookDelivery, PgSync } from "./db/pg-sync.js";
import {
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  MAX_ATTEMPTS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  decideRetry,
  signBody,
  type DeliveryFailureCode,
} from "./outgoing-webhook-delivery.js";
import { SsrfBlockedError, secureFetch } from "./secure-fetch.js";

// Outgoing-webhook delivery runner (#598). A tick() that:
//   1. claims due webhook_outbox rows (FOR UPDATE SKIP LOCKED, joined to the
//      parent webhook's url + secret hash) so exactly one tick (across relay
//      instances) attempts each row,
//   2. signs HMAC-SHA256(secretKeyHash, body) → X-Cyborg7-Signature and POSTs
//      the stored body via the shared secureFetch (SSRF-guarded; redirects
//      refused — a webhook target must answer 2xx directly),
//   3. 2xx → success (stamp delivered, reset the webhook's failure counter);
//      non-2xx / timeout / SSRF-block / network error → retry with exponential
//      backoff + jitter, and at the cap (5) DEAD-LETTER the row, DEACTIVATE the
//      webhook, and DM its owner,
//   4. writes a per-attempt webhook_delivery_logs audit row either way.
//
// The runner is PURE I/O orchestration over PgSync + secureFetch; all the
// signing/backoff/shape decisions live in outgoing-webhook-delivery.ts (unit-
// tested there). It owns NO timer — the host (relay main() / daemon bootstrap)
// pumps tick() on an interval (~60s). Re-entrancy-guarded so a slow pass can't
// overlap the next tick. Secrets are NEVER logged.

export interface WebhookDeliveryRunnerDeps {
  pg: PgSync;
  logger: Logger;
  // Post a system DM to a user (the webhook owner) telling them their webhook was
  // auto-disabled after repeated failures. Injected so the runner works both on
  // the cloud relay (injectMessage as a dm_broadcast) and a solo daemon
  // (MessageRouter.handleDm). A throw here is swallowed — notification is best
  // effort and must never block the delivery loop.
  notifyOwner: (opts: {
    workspaceId: string;
    userId: string;
    webhookName: string;
    url: string;
  }) => void | Promise<void>;
  // Injectable clock for deterministic tests.
  now?: () => number;
  // Max rows claimed per tick.
  batchSize?: number;
  // Per-delivery wall-clock budget (ms).
  timeoutMs?: number;
}

export class WebhookDeliveryRunner {
  private readonly pg: PgSync;
  private readonly logger: Logger;
  private readonly notifyOwner: WebhookDeliveryRunnerDeps["notifyOwner"];
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private ticking = false;

  constructor(deps: WebhookDeliveryRunnerDeps) {
    this.pg = deps.pg;
    this.logger = deps.logger;
    this.notifyOwner = deps.notifyOwner;
    this.now = deps.now ?? Date.now;
    this.batchSize = deps.batchSize ?? 20;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  // One pass over the due rows. Public so the host tick + tests can drive it.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.pg.claimDueWebhookDeliveries(this.now(), this.batchSize);
      // Deliver claimed rows concurrently — each is an independent outbound POST,
      // and the claim already leased them so there's no cross-row contention.
      await Promise.all(due.map((row) => this.deliverOne(row)));
    } catch (err) {
      this.logger.warn({ err }, "[webhook-delivery] tick failed");
    } finally {
      this.ticking = false;
    }
  }

  // Attempt one claimed delivery. `row.attempts` is the 1-based number of THIS
  // attempt (the claim already incremented it). Never throws — all outcomes are
  // recorded.
  //
  // The HTTP post is the ONLY thing in the first try: ONLY a transport failure
  // is an actual delivery failure. The onSuccess/onFailure outcome WRITES each
  // get their own try/catch so a DB error while recording an outcome is logged
  // but never cross-contaminates success/failure — a 2xx that we then fail to
  // persist must NOT be re-recorded as a delivery failure (the lease expires and
  // the row is re-attempted, which is the correct recovery).
  private async deliverOne(row: DueWebhookDelivery): Promise<void> {
    const now = this.now();
    const body = JSON.stringify(row.eventData);
    let res: Response;
    try {
      res = await this.post(row, body);
    } catch (err) {
      try {
        await this.onFailure(row, now, classifyError(err));
      } catch (dbErr) {
        this.logger.error(
          { err: dbErr, outboxId: row.outboxId },
          "[webhook-delivery] failed to write failure outcome",
        );
      }
      return;
    }

    if (res.status >= 200 && res.status < 300) {
      try {
        await this.onSuccess(row, res.status, now);
      } catch (dbErr) {
        this.logger.error(
          { err: dbErr, outboxId: row.outboxId },
          "[webhook-delivery] failed to write success outcome",
        );
      }
    } else {
      // Non-2xx HTTP response → retryable http_error.
      try {
        await this.onFailure(row, now, {
          code: "http_error",
          responseStatus: res.status,
          message: `HTTP ${res.status}`,
        });
      } catch (dbErr) {
        this.logger.error(
          { err: dbErr, outboxId: row.outboxId },
          "[webhook-delivery] failed to write failure outcome",
        );
      }
    }
  }

  // Sign + POST the stored body. Redirects are refused (followRedirects defaults
  // false in secureFetch) — a webhook endpoint must answer 2xx directly, and a
  // 3xx is the classic SSRF bypass. The body is drained by the caller's status
  // check; we cap how much we read so a hostile endpoint can't stream forever.
  private async post(row: DueWebhookDelivery, body: string): Promise<Response> {
    const ts = String(this.now());
    const res = await secureFetch(row.url, {
      timeoutMs: this.timeoutMs,
      maxBytes: 64 * 1024, // we don't use the response body; cap it tightly
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Cyborg7-Webhook/1.0",
          [SIGNATURE_HEADER]: signBody(row.secretKeyHash, body),
          [TIMESTAMP_HEADER]: ts,
          [EVENT_HEADER]: row.eventType,
          [DELIVERY_ID_HEADER]: row.outboxId,
        },
        body,
      },
    });
    // Free the socket — we only needed the status line/headers.
    // intentional: best-effort body teardown; the status is already captured.
    res.body?.cancel().catch(() => {});
    return res;
  }

  private async onSuccess(row: DueWebhookDelivery, status: number, now: number): Promise<void> {
    await this.pg.markWebhookOutboxDelivered(row.outboxId, now);
    await this.pg.applyWebhookDeliveryOutcome({
      webhookId: row.webhookId,
      now,
      success: true,
    });
    await this.logAttempt(row, {
      status: "success",
      responseStatus: status,
      retryCount: row.attempts,
      nextRetryAt: null,
    });
    this.logger.info(
      { event: "webhook_delivered", webhookId: row.webhookId, outboxId: row.outboxId, status },
      "webhook delivered",
    );
  }

  private async onFailure(
    row: DueWebhookDelivery,
    now: number,
    failure: { code: DeliveryFailureCode; responseStatus?: number; message: string },
  ): Promise<void> {
    const decision = decideRetry(row.attempts, now);
    if (decision.willRetry && decision.nextRetryAt !== null) {
      // Transient — push the row out to the backoff time; the webhook row records
      // the failure (failure_count++) but stays active.
      await this.pg.rescheduleWebhookOutbox(row.outboxId, decision.nextRetryAt);
      await this.pg.applyWebhookDeliveryOutcome({
        webhookId: row.webhookId,
        now,
        success: false,
        error: failure.message,
      });
      await this.logAttempt(row, {
        status: "failure",
        responseStatus: failure.responseStatus ?? null,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryCount: row.attempts,
        nextRetryAt: decision.nextRetryAt,
      });
      this.logger.warn(
        {
          event: "webhook_delivery_retry",
          webhookId: row.webhookId,
          outboxId: row.outboxId,
          attempt: row.attempts,
          code: failure.code,
          status: failure.responseStatus ?? null,
        },
        "webhook delivery failed; will retry",
      );
      return;
    }

    // Cap reached → dead-letter the outbox row, deactivate the webhook, DM owner.
    await this.pg.markWebhookOutboxDelivered(row.outboxId, now);
    const outcome = await this.pg.applyWebhookDeliveryOutcome({
      webhookId: row.webhookId,
      now,
      success: false,
      deactivate: true,
      error: failure.message,
    });
    await this.logAttempt(row, {
      status: "failure",
      responseStatus: failure.responseStatus ?? null,
      errorCode: failure.code,
      errorMessage: failure.message,
      retryCount: row.attempts,
      nextRetryAt: null,
    });
    this.logger.warn(
      {
        event: "webhook_deactivated",
        webhookId: row.webhookId,
        outboxId: row.outboxId,
        attempts: row.attempts,
        cap: MAX_ATTEMPTS,
        code: failure.code,
      },
      "webhook deactivated after repeated delivery failures",
    );
    if (outcome?.deactivated) {
      try {
        await this.notifyOwner({
          workspaceId: row.workspaceId,
          userId: outcome.createdBy,
          webhookName: outcome.name,
          url: outcome.url,
        });
      } catch (err) {
        // Best effort — a failed DM must not block or re-fail the loop.
        this.logger.warn({ err, webhookId: row.webhookId }, "[webhook-delivery] owner DM failed");
      }
    }
  }

  private async logAttempt(
    row: DueWebhookDelivery,
    opts: {
      status: "success" | "failure";
      responseStatus?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      retryCount: number;
      nextRetryAt: number | null;
    },
  ): Promise<void> {
    try {
      await this.pg.insertWebhookDeliveryLog({
        id: randomUUID(),
        webhookId: row.webhookId,
        outboxId: row.outboxId,
        workspaceId: row.workspaceId,
        eventType: row.eventType,
        status: opts.status,
        responseStatus: opts.responseStatus ?? null,
        errorCode: opts.errorCode ?? null,
        errorMessage: opts.errorMessage ?? null,
        retryCount: opts.retryCount,
        nextRetryAt: opts.nextRetryAt,
      });
    } catch (err) {
      // The audit log is non-critical — never let it break delivery bookkeeping.
      this.logger.debug({ err, outboxId: row.outboxId }, "[webhook-delivery] log write failed");
    }
  }
}

// Map a thrown delivery error to a closed-set failure code + message. An
// SsrfBlockedError (guard refused the URL/redirect) is distinct from a timeout
// (AbortError) and a generic network failure.
function classifyError(err: unknown): {
  code: DeliveryFailureCode;
  message: string;
} {
  if (err instanceof SsrfBlockedError) {
    return { code: "ssrf_blocked", message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      return { code: "timeout", message: "request timed out" };
    }
    if (/size cap/i.test(err.message)) {
      return { code: "http_error", message: err.message };
    }
    return { code: "network_error", message: err.message };
  }
  return { code: "network_error", message: "unknown delivery error" };
}
