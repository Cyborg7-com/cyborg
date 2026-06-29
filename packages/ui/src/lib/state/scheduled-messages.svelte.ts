// ─── Scheduled messages (#607 — user send-later) ────────────────────
// Client state for the per-workspace list of the caller's scheduled messages
// (the "Scheduled" pane). Loaded on demand via cyborg:schedule_message_list,
// kept in sync with create/cancel actions, and patched live when a scheduled
// send FAILS at fire time (cyborg:schedule_message_failed broadcast — wired in
// app.svelte.ts, the single place client.on(...) handlers live).
//
// Rows are sorted soonest-first by sendAt. Status is DERIVED (see
// scheduledStatus), never stored as an enum, matching the server contract:
//   PENDING  processedAt === null
//   SENT     processedAt !== null && errorCode === null
//   FAILED   errorCode !== null

import { client } from "./client.js";
import type { ScheduledMessage, ScheduledMessageErrorCode } from "../core/types.js";

export type ScheduledStatus = "pending" | "sent" | "failed";

// Derive the lifecycle status from the row's processedAt + errorCode (the server
// sends no status field — see the contract above).
export function scheduledStatus(m: ScheduledMessage): ScheduledStatus {
  if (m.errorCode !== null) return "failed";
  if (m.processedAt !== null) return "sent";
  return "pending";
}

// Friendly, user-facing copy for each failure code. Kept here (not in the
// component) so any surface that renders a failed row stays consistent.
const ERROR_LABELS: Record<ScheduledMessageErrorCode, string> = {
  channel_archived: "Channel archived",
  no_permission: "No permission",
  user_deleted: "Recipient unavailable",
  channel_not_found: "Channel not found",
  unknown_error: "Couldn't send",
};

export function scheduledErrorLabel(code: ScheduledMessageErrorCode): string {
  return ERROR_LABELS[code] ?? ERROR_LABELS.unknown_error;
}

function bySendAt(a: ScheduledMessage, b: ScheduledMessage): number {
  return a.sendAt - b.sendAt;
}

export class ScheduledMessagesState {
  // The loaded rows for `workspaceId`, soonest-first. Reassigned on every
  // mutation so the runes observe the change.
  messages: ScheduledMessage[] = $state([]);
  loading = $state(false);
  // Human-readable load error (null = none). Distinct from a row's own
  // errorCode — this is "the LIST couldn't load", surfaced as a pane error state.
  error: string | null = $state(null);
  // Which workspace the current `messages` belong to — guards a late list
  // response from landing in a workspace the user has since switched away from.
  private loadedWorkspaceId: string | null = null;

  get pendingCount(): number {
    return this.messages.reduce((n, m) => n + (scheduledStatus(m) === "pending" ? 1 : 0), 0);
  }

  // Load (or reload) the caller's scheduled messages for a workspace. Safe to
  // call repeatedly (e.g. on pane mount / workspace change / after a cancel).
  async load(workspaceId: string): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const { messages } = await client.scheduleMessageList(workspaceId);
      // Drop the result if the user switched workspaces while it was in flight.
      this.loadedWorkspaceId = workspaceId;
      this.messages = [...messages].sort(bySendAt);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Couldn't load scheduled messages";
      this.messages = [];
    } finally {
      this.loading = false;
    }
  }

  // Insert/replace a row from a create response so the list reflects a just-
  // scheduled message without a full reload (used when scheduling from the
  // composer while the pane is open, and idempotent if a reload also lands).
  upsert(message: ScheduledMessage): void {
    // Only track rows for the currently loaded workspace; a row for another
    // workspace would never be shown and just bloats the list.
    if (this.loadedWorkspaceId !== null && message.workspaceId !== this.loadedWorkspaceId) return;
    const next = this.messages.filter((m) => m.id !== message.id);
    next.push(message);
    this.messages = next.sort(bySendAt);
  }

  // Cancel a pending row, then drop it from the list. Returns the error string on
  // failure (e.g. the row already fired) so the caller can surface it inline.
  async cancel(workspaceId: string, id: string): Promise<string | null> {
    try {
      const res = await client.scheduleMessageCancel(workspaceId, id);
      if (!res.ok) return res.error ?? "Couldn't cancel";
      this.messages = this.messages.filter((m) => m.id !== id);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn't cancel";
    }
  }

  // Patch a row live when its send FAILED at fire time (broadcast handler). If the
  // row isn't loaded yet (pane never opened this session) it's ignored — a later
  // load() will reflect it. Scoped to the loaded workspace.
  applyFailed(message: ScheduledMessage): void {
    if (this.loadedWorkspaceId !== null && message.workspaceId !== this.loadedWorkspaceId) return;
    const idx = this.messages.findIndex((m) => m.id === message.id);
    if (idx < 0) return;
    this.messages[idx] = message;
    this.messages = this.messages.slice();
  }

  // Drop all state on logout / workspace teardown.
  clear(): void {
    this.messages = [];
    this.loading = false;
    this.error = null;
    this.loadedWorkspaceId = null;
  }
}

export const scheduledMessagesState = new ScheduledMessagesState();
