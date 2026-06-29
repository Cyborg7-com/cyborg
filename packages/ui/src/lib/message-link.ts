// Builds a shareable permalink to a single message, mirroring the workspace
// route shape: <origin>/workspace/<wsId>/channel/<channelId>/message/<messageId>.
// The message carries its own workspaceId/channelId; we fall back to the active
// workspace id for older messages that predate the workspaceId field. Returns
// null when there isn't enough context to build a stable link (e.g. a DM or a
// system message with no channel), so callers can hide/disable the affordance.
import type { Message } from "./types.js";
import { workspaceState } from "./state/app.svelte.js";

export function buildMessageLink(message: Message): string | null {
  const wsId = message.workspaceId ?? workspaceState.current?.id;
  const channelId = message.channelId;
  if (!wsId || !channelId) return null;
  const origin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  return `${origin}/workspace/${wsId}/channel/${channelId}/message/${message.id}`;
}
