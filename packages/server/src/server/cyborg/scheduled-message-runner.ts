import type { Logger } from "pino";

import type { CyborgAuthContext } from "./auth.js";
import type { DualStorage } from "./dual-storage.js";
import type { MessageRouter } from "./message-router.js";
import type { BroadcastFn } from "./message-router.js";
import { decideScheduledSend, type ScheduledSendContext } from "./scheduled-message-send.js";
import type { StoredScheduledMessage } from "./storage.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export interface ScheduledMessageRunnerOptions {
  storage: DualStorage;
  workspaceManager: WorkspaceManager;
  messageRouter: MessageRouter;
  broadcast: BroadcastFn;
  logger: Logger;
}

// Daemon-side "send later" runner (#607). NO timer of its own — driven by the
// existing ScheduleRunner tick (the cybo cron runner pumps tick() each minute),
// so there is a SINGLE daemon timer, not a second one. Each tick reads due +
// unprocessed scheduled_messages from local SQLite, re-validates the author's
// authority + the target at SEND time, fires the survivors through the NORMAL
// message path (MessageRouter — so mentions/notifications/persistence all work),
// and stamps processed_at. A failed send records a closed-set error_code and is
// broadcast to the author (never silently dropped).
//
// Connected vs solo: when this daemon has a PG connection, the CLOUD relay's tick
// is the single firer (atomic FOR UPDATE SKIP LOCKED on PG) — the daemon must NOT
// also fire, or a row fires twice. So tick() no-ops unless the daemon is solo
// (storage.pg === null). Writes still mirror to PG (see DualStorage) so the cloud
// list sees solo-daemon rows; but the FIRE happens in exactly one place per row.
export class ScheduledMessageRunner {
  private readonly storage: DualStorage;
  private readonly workspaceManager: WorkspaceManager;
  private readonly messageRouter: MessageRouter;
  private readonly broadcast: BroadcastFn;
  private readonly logger: Logger;
  private ticking = false;

  constructor(options: ScheduledMessageRunnerOptions) {
    this.storage = options.storage;
    this.workspaceManager = options.workspaceManager;
    this.messageRouter = options.messageRouter;
    this.broadcast = options.broadcast;
    this.logger = options.logger;
  }

  // One pass over the due rows. Public so the host tick (ScheduleRunner) and tests
  // can drive it. Re-entrancy-guarded so a slow pass can't overlap the next tick.
  async tick(now: number = Date.now()): Promise<void> {
    // Connected daemon → the cloud relay's PG tick owns firing; don't double-fire.
    if (this.storage.pg) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = this.storage.getDueScheduledMessages(now);
      for (const row of due) {
        await this.fireOne(row, now);
      }
    } catch (err) {
      this.logger.warn({ err }, "[scheduled-message] tick failed");
    } finally {
      this.ticking = false;
    }
  }

  // Validate + fire a single due row, claiming it first so a re-entrant tick (or a
  // crash mid-send) can't double-send. The claim IS the idempotency guard
  // (markScheduledMessageProcessed only stamps a row whose processed_at IS NULL).
  private async fireOne(row: StoredScheduledMessage, now: number): Promise<void> {
    const ctx = this.buildContext(row);
    const decision = decideScheduledSend(ctx);

    if (decision.kind === "fail") {
      // Stamp processed + error_code atomically (claims the row). If another tick
      // beat us to it, claimed=false and we don't re-broadcast.
      const claimed = this.storage.markScheduledMessageProcessed(row.id, now, decision.errorCode);
      if (claimed) this.broadcastFailed(row.id);
      return;
    }

    // CLAIM before sending: stamp processed_at (success-shaped, error_code null) so
    // a concurrent/re-entrant tick skips this row. Only the tick that wins the
    // claim proceeds to send.
    const claimed = this.storage.markScheduledMessageProcessed(row.id, now, null);
    if (!claimed) return; // already fired by another pass

    try {
      this.send(row);
    } catch (err) {
      // The row is already claimed (processed_at set), so it won't be retried into
      // a loop — but a failed send must still be SHOWN. Record the reason on the
      // claimed row and tell the author.
      this.logger.warn({ err, id: row.id }, "[scheduled-message] send failed after claim");
      this.storage.setScheduledMessageError(row.id, "unknown_error");
      this.broadcastFailed(row.id);
    }
  }

  // Gather the facts decideScheduledSend needs: author authority (re-checked now)
  // + target existence/archived state. Read from local SQLite (authoritative for
  // this solo daemon's workspaces).
  private buildContext(row: StoredScheduledMessage): ScheduledSendContext {
    const { allowed } = this.workspaceManager.checkPermission(
      row.workspace_id,
      row.from_id,
      "send_message",
    );
    const channel = row.channel_id ? this.storage.getChannel(row.channel_id) : undefined;
    const recipient = row.to_id ? this.storage.getUserById(row.to_id) : undefined;
    return {
      channelId: row.channel_id,
      toId: row.to_id,
      authorCanSend: allowed,
      channelExists: row.channel_id !== null && channel !== undefined,
      channelArchived: channel?.is_archived === 1,
      recipientExists: row.to_id !== null && recipient !== undefined,
    };
  }

  // Fire the row through the NORMAL message path so it's indistinguishable from a
  // live human send (persisted, broadcast, mentions notified). The author's
  // identity drives attribution; authority was already re-validated above.
  private send(row: StoredScheduledMessage): void {
    const author = this.storage.getUserById(row.from_id);
    const auth: CyborgAuthContext = {
      user: {
        id: row.from_id,
        email: author?.email ?? `${row.from_id}@unknown.local`,
        name: author?.name ?? null,
      },
      workspaces: [],
    };
    const mentions = row.mentions ? (JSON.parse(row.mentions) as string[]) : undefined;

    if (row.channel_id) {
      this.messageRouter.handleChannelMessage(auth, {
        type: "cyborg:channel_message",
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        text: row.text,
        mentions,
      });
    } else if (row.to_id) {
      this.messageRouter.handleDm(auth, {
        type: "cyborg:dm",
        workspaceId: row.workspace_id,
        toId: row.to_id,
        text: row.text,
      });
    }
  }

  // Push the failed row (now stamped with its error_code) to the author so the
  // Scheduled list flips pending → failed live, then a re-list confirms it.
  private broadcastFailed(id: string): void {
    const updated = this.storage.getScheduledMessage(id);
    if (!updated) return;
    this.broadcast.toUser(updated.from_id, {
      type: "cyborg:schedule_message_failed",
      payload: scheduledMessageView(updated),
    });
  }
}

// Map a stored row to the wire view the client expects (epoch-ms numbers,
// parsed mentions). Shared shape with the dispatcher/relay list responses.
export function scheduledMessageView(row: StoredScheduledMessage): {
  id: string;
  workspaceId: string;
  channelId: string | null;
  toId: string | null;
  fromId: string;
  text: string;
  mentions: string[] | null;
  sendAt: number;
  processedAt: number | null;
  errorCode: StoredScheduledMessage["error_code"];
  createdAt: number;
} {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    toId: row.to_id,
    fromId: row.from_id,
    text: row.text,
    mentions: row.mentions ? (JSON.parse(row.mentions) as string[]) : null,
    sendAt: row.send_at,
    processedAt: row.processed_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
  };
}
