import { z } from "zod";
import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import {
  AgentStreamEventPayloadSchema as AgentStreamEventPayloadRuntimeSchema,
  SessionInboundMessageSchema as PaseoSessionInboundMessageSchema,
  WSPingMessageSchema,
  WSHelloMessageSchema,
  WSRecordingStateMessageSchema,
} from "@getpaseo/protocol/messages";
import { CyborgInboundSchemas } from "./cyborg/cyborg-messages.js";

export * from "@getpaseo/protocol/messages";

// Cyborg7: extend Paseo's inbound discriminated union with our collaborative
// workspace message types. This lives in the server layer (not in
// @getpaseo/protocol) so the protocol package stays a pure Paseo dependency —
// importing CyborgInboundSchemas there would invert the package dependency
// (protocol → server). These explicit named exports take precedence over the
// `export *` above, so every consumer that imports SessionInboundMessageSchema /
// SessionInboundMessage from this module gets the cyborg-aware union.
export const SessionInboundMessageSchema = z.discriminatedUnion("type", [
  ...PaseoSessionInboundMessageSchema.options,
  ...CyborgInboundSchemas,
]);

export type SessionInboundMessage = z.infer<typeof SessionInboundMessageSchema>;

// Cyborg7: rebuild the WS envelope schema on top of the cyborg-aware session
// union above. The protocol package's WSInboundMessageSchema wraps Paseo's
// (cyborg-unaware) SessionInboundMessageSchema, so a `{type:"session", message:
// {type:"cyborg:auth", ...}}` frame fails validation at the WebSocket boundary
// (websocket-server.ts) before it can reach the cyborg dispatcher — the request
// is silently dropped and a CLI talking directly to a headless daemon times out.
// Re-deriving the WS schema here (where SessionInboundMessageSchema includes the
// cyborg inbound types) lets those frames through to the dispatcher. As with the
// session override above, this named export takes precedence over `export *`, so
// every consumer importing WSInboundMessageSchema from this module is cyborg-aware.
export const WSSessionInboundSchema = z.object({
  type: z.literal("session"),
  message: SessionInboundMessageSchema,
});

export const WSInboundMessageSchema = z.discriminatedUnion("type", [
  WSPingMessageSchema,
  WSHelloMessageSchema,
  WSRecordingStateMessageSchema,
  WSSessionInboundSchema,
]);

export type WSInboundMessage = z.infer<typeof WSInboundMessageSchema>;

function validateStreamEventPayload(payload: unknown): AgentStreamEventPayload | null {
  const parsed = AgentStreamEventPayloadRuntimeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function serializeAgentSnapshot(
  agent: ManagedAgent,
  options?: { title?: string | null },
): AgentSnapshotPayload {
  return toAgentPayload(agent, options);
}

export function serializeAgentStreamEvent(event: AgentStreamEvent): AgentStreamEventPayload | null {
  if (event.type === "attention_required") {
    // Providers may emit attention_required without per-client notification context.
    // The websocket server emits attention_required with shouldNotify computed per client.
    // Normalize provider events so they satisfy the shared schema.
    return validateStreamEventPayload({
      type: "attention_required",
      provider: event.provider,
      reason: event.reason,
      timestamp: event.timestamp,
      shouldNotify: false,
    });
  }

  return validateStreamEventPayload(event);
}
