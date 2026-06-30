/* eslint-disable @typescript-eslint/no-explicit-any */
// PG-GATED END-TO-END proof for the cloud DM→cybo channel-leak fix (#1057).
//
// THE BUG: in CLOUD mode a user DMs a cybo whose persistent session is
// CHANNEL-BOUND (binding.channel_id = #general, the shape a cron leaves behind).
// The cybo's reply must land in the DM only — but pre-fix it ALSO leaked into
// #general, because the cloud path
//
//   cyborg:send_agent_prompt  →  cyborg:agent_prompt_forward
//                             →  bootstrap routeForwardedPrompt  →  routeToAgent
//
// bypassed MessageRouter.handleDm, so the DM guard (dmTurnRecipient) was never
// armed. With the guard off, BOTH leak vectors fire:
//   - Layer B: the cybo's cyborg7_send_message({channel}) tool call posts straight
//     to #general (handleAgentMessage, channelId not nulled), and
//   - the relay flush: emitAgentStream tags the agent_stream with channelId=#general
//     + privateToEmail=null, so the relay persists/broadcasts the reply to #general.
//
// THE FIX (the three seams this test exercises end-to-end):
//   1. the relay sends `dmRecipient` on the forward (relay-standalone.ts),
//   2. the daemon's routeForwardedPrompt routes a forward carrying dmRecipient
//      through routeDmTurn — which ARMS the in-process DM guard (message-router.ts),
//   3. emitAgentStream then nulls the channel + sets privateToEmail, and the relay
//      flush (workspace-relay.ts) treats privateToEmail as AUTHORITATIVE DM scope.
//
// Unlike the unit guards (message-router-dm-channel-guard.test.ts stubs
// routeToAgent; workspace-relay-dm-flush-guard.test.ts stubs PgSync), this test
// wires the REAL MessageRouter (driving a stub provider that ACTIVELY tries to
// leak) into the REAL WorkspaceRelay flush against REAL Postgres, so it proves the
// daemon-side ARMING and the relay-side ENFORCEMENT close the leak TOGETHER over a
// real daemon→relay hop.
//
// Skipped when DATABASE_URL is unset (committable, a no-op in CI):
//   DATABASE_URL=postgresql://cyborg7@localhost:5544/cyborg7 \
//     npx vitest run src/server/cyborg/dm-channel-leak-e2e.integration.test.ts
//
// FORCE_BROKEN=1 reverts seam #2 in-test (routeForwardedPrompt ignores dmRecipient
// → bare routeToAgent) to demonstrate the test goes RED on the pre-fix behavior.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { getPool, closePool } from "./db/connection.js";
import { PgSync } from "./db/pg-sync.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceRelay } from "./workspace-relay.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentPromptInput } from "../agent/agent-prompt.js";

const hasPg = !!process.env.DATABASE_URL;
// Set to 1 to revert the daemon-side fix (seam #2) and prove the test goes RED.
const FORCE_BROKEN = process.env.FORCE_BROKEN === "1";

describe.skipIf(!hasPg)(
  "cloud DM→cybo channel leak — real relay↔daemon hop (requires DATABASE_URL)",
  () => {
    const runId = randomUUID().slice(0, 8);
    const wsId = `ws_dmleak_${randomUUID()}`;
    // The requesting human. The relay forwards dmRecipient = { CLOUD id, email };
    // the daemon resolves the LOCAL id by email (cloud id ≠ local id). We mint a
    // RANDOM cloud id and let SQLite derive its own LOCAL id from the email, so the
    // routeForwardedPrompt email→local-id bridge is genuinely exercised.
    const cloudUserId = `u_cloud_${randomUUID()}`;
    const userEmail = `dmleak-${runId}@pg-it.dev`;
    // A SECOND human + #general member, so a leaked channel post would be visible to
    // someone other than the DM initiator (the leak's real-world harm).
    const bystanderId = `u_bystander_${randomUUID()}`;
    const cyboAgentId = `agent_dm_${randomUUID()}`; // the channel-bound (cron) session
    const mentionAgentId = `agent_mention_${randomUUID()}`; // the negative-baseline session

    // Resolved in beforeAll (SQLite derives the local id + cybo id).
    let localUserId: string;
    let cyboId: string;
    let generalChId: string;

    let tmpDir: string;
    let storage: DualStorage;
    let pg: PgSync;
    let relay: WorkspaceRelay;
    let router: MessageRouter;
    // Captures the relay's onBroadcast output (what guests actually receive).
    let relayBroadcasts: Array<{ type: string; payload: any }>;
    // The agent-event subscriber emitAgentStream broadcasts through (captured from
    // the stub AgentManager.subscribe call).
    let subscriberCb: ((event: unknown) => void) | null = null;
    let seq = 0;

    // ── helpers ──────────────────────────────────────────────────────

    function nextSeq(): number {
      return ++seq;
    }

    // Count a cybo's own messages persisted into #general (the leak target).
    async function pgChannelMsgCountFromCybo(text: string): Promise<number> {
      const out = await getPool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE workspace_id = $1 AND channel_id = $2 AND from_id = $3 AND text = $4",
        [wsId, generalChId, cyboId, text],
      );
      return Number(out.rows[0].n);
    }

    // The cybo's DM reply persisted with channelId NULL, from the cybo. (to_id is
    // null by design — flushPendingAgentMessage nulls it; the recipient rides the
    // dm_broadcast.) A row here = the reply was persisted at DM scope, not a channel.
    async function pgDmReply(text: string): Promise<{ id: string } | undefined> {
      const out = await getPool().query<{ id: string }>(
        "SELECT id FROM messages WHERE workspace_id = $1 AND channel_id IS NULL AND from_id = $2 AND text = $3",
        [wsId, cyboId, text],
      );
      return out.rows[0];
    }

    // Poll a real-PG read until it returns a row (relay persist is async).
    async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // FAITHFUL replica of bootstrap.ts `routeForwardedPrompt` (it's a closure inside
    // createPaseoDaemon, not exported). This IS the daemon code under test for seam
    // #2: a forward carrying dmRecipient resolves the LOCAL recipient by email and
    // routes through the ARMED DM path (routeDmTurn); without dmRecipient it
    // bare-routes (a non-DM channel turn). FORCE_BROKEN reverts to the pre-fix
    // behavior (always bare routeToAgent) — the exact regression #1057 closes.
    function routeForwardedPrompt(fwd: {
      agentId: string;
      prompt: string;
      dmRecipient?: { userId: string; email: string };
    }): Promise<void> {
      if (FORCE_BROKEN || !fwd.dmRecipient) {
        // PRE-FIX cloud path (or a genuine non-DM channel turn): no DM guard.
        return router.routeToAgent(fwd.agentId, fwd.prompt, { rawPrompt: fwd.prompt });
      }
      const localUser = fwd.dmRecipient.email
        ? storage.getUserByEmail(fwd.dmRecipient.email)
        : undefined;
      const recipientId = localUser?.id ?? fwd.dmRecipient.userId;
      const dmPrompt = router.buildDmPrompt({
        userId: recipientId,
        name: localUser?.name ?? localUser?.email ?? fwd.dmRecipient.email,
        text: fwd.prompt,
      });
      return router.routeDmTurn(
        fwd.agentId,
        { userId: recipientId, email: fwd.dmRecipient.email },
        dmPrompt as AgentPromptInput,
        { rawPrompt: fwd.prompt },
      );
    }

    // Re-emit a stream event through the captured agent-event subscriber so it flows
    // through the REAL emitAgentStream → broadcast → relay path (exactly how
    // AgentManager dispatches inference-time stream events to MessageRouter).
    function emitToSubscriber(agentId: string, event: Record<string, unknown>): void {
      subscriberCb?.({ type: "agent_stream", agentId, event });
    }

    // Install a stub AgentManager whose ONE turn ACTIVELY tries to leak: it (1) calls
    // the cybo's cyborg7_send_message({channel}) tool (= handleAgentMessage on the
    // bound channel — leak vector A) AND (2) emits the same reply as an
    // assistant_message stream, then turn_completed (the relay flush path — leak
    // vector B). The cybo doesn't "know" it's a DM: its channel-bound session prompt
    // still says "post to #general", so it does both — exactly the bug's behavior.
    function installLeakingProvider(replyText: string): void {
      const fakeAgentManager = {
        subscribe: (cb: (event: unknown) => void) => {
          subscriberCb = cb; // emitAgentStream broadcasts via this for non-ephemeral agents
          return () => {};
        },
        getAgent: (id: string) => ({ id, provider: "pi" }),
        appendTimelineItem: async () => {},
        closeAgent: async () => {},
        cancelAgentRun: async () => true,
        streamAgent: (agentId: string): AsyncGenerator<unknown> => {
          const boundChannel = storage.getAgentBinding(agentId)?.channel_id ?? generalChId;
          // The turn's stream events. AgentManager both yields these from streamAgent
          // AND dispatches them to subscribers; emitAgentStream (the relay-flush path)
          // fires off the SUBSCRIBER, so we drive both — yield for routeToAgent's drain
          // and push to the captured subscriber for the broadcast.
          const events: Array<Record<string, unknown>> = [
            {
              type: "timeline",
              item: { type: "assistant_message", text: replyText, messageId: randomUUID() },
            },
            { type: "turn_completed", provider: "pi" },
          ];
          async function* run(): AsyncGenerator<unknown> {
            // (A) the cybo tries to post its reply to its bound channel via the tool.
            router.handleAgentMessage(agentId, wsId, boundChannel, null, replyText);
            // (B) stream the assistant reply + complete the turn (the flush trigger):
            // dispatch to the subscriber (drives emitAgentStream) AND yield it.
            for (const ev of events) {
              emitToSubscriber(agentId, ev);
              yield ev;
            }
          }
          return run();
        },
      };
      router.setAgentManager(fakeAgentManager as unknown as AgentManager);
    }

    // ── seed: real PG (authoritative) + the SQLite cache ─────────────

    beforeAll(async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-dmleak-"));
      const sqlite = new CyborgStorage(path.join(tmpDir, "cache.db"));
      pg = new PgSync();
      storage = new DualStorage(sqlite, pg);
      const workspaceManager = new WorkspaceManager(storage);

      // Relay → capture what guests would receive (channel post vs DM).
      relayBroadcasts = [];
      relay = new WorkspaceRelay({
        pg,
        onBroadcast: (_wid, message) => {
          relayBroadcasts.push(message as any);
        },
      });

      // The daemon→relay hop: pipe MessageRouter's agent_stream broadcasts straight
      // into the REAL relay persistMessage, so the relay's accumulate→flush→
      // broadcastAgentReply chain runs against real PG exactly as it does when a
      // daemon forwards these over the wire. (Only agent_stream — the cybo's reply
      // arrives via the stream-flush path, which is the surface the relay-side
      // enforcement guards; piping the daemon's own direct channel post too would
      // double-persist the same text and obscure which path persisted it.)
      const broadcast: BroadcastFn = {
        toWorkspace: (workspaceId: string, msg: any) => {
          if (msg?.type === "cyborg:agent_stream") {
            void (
              relay as unknown as {
                persistMessage(w: string, s: number, m: Record<string, unknown>): Promise<void>;
              }
            ).persistMessage(workspaceId, nextSeq(), msg);
          }
        },
        toUser: () => {},
      };
      router = new MessageRouter(storage, workspaceManager, broadcast);

      // SQLite cache: the requesting user — upsertUser derives a LOCAL id from the
      // email (≠ the random CLOUD id above), so routeForwardedPrompt's email→local-id
      // bridge has real work to do.
      const localUser = sqlite.upsertUser(userEmail, "DM User");
      localUserId = localUser.id;
      sqlite.createWorkspaceWithId(wsId, `DMLeak ${runId}`, localUserId);
      sqlite.addMember(wsId, localUserId, "member");
      const sqliteCybo = sqlite.createCybo({
        workspaceId: wsId,
        slug: "rick",
        name: "Rick",
        soul: "You are Rick.",
        provider: "pi",
        createdBy: localUserId,
      });
      cyboId = sqliteCybo.id;
      generalChId = sqlite.createChannel(wsId, "general", localUserId).id;

      // The CHANNEL-BOUND persistent (cron) session: a non-ephemeral binding whose
      // channel_id = #general — the exact state a scheduled cybo leaves behind, the
      // leak surface. emitAgentStream reads cybo_id off the binding so the persisted
      // reply is attributed to the cybo.
      sqlite.createAgentBinding({
        agentId: cyboAgentId,
        workspaceId: wsId,
        channelId: generalChId,
        provider: "pi",
        cyboId,
        initiatedBy: localUserId,
        ephemeral: false,
      });
      // The negative-baseline session: ALSO channel-bound to #general (a cybo that
      // legitimately answers an @mention in the channel).
      sqlite.createAgentBinding({
        agentId: mentionAgentId,
        workspaceId: wsId,
        channelId: generalChId,
        provider: "pi",
        cyboId,
        initiatedBy: localUserId,
        ephemeral: false,
      });

      // REAL PG seed (the relay flush reads/writes here). ids MUST match SQLite so
      // the persisted reply is attributed + scoped identically across the hop.
      await pg.upsertUser(localUserId, userEmail, "DM User");
      await pg.upsertUser(cloudUserId, `cloud-${userEmail}`, "DM User (cloud)");
      await pg.upsertUser(bystanderId, `bystander-${runId}@pg-it.dev`, "Bystander");
      await pg.createWorkspace(wsId, `DMLeak ${runId}`, localUserId);
      await pg.addMember(wsId, localUserId, "member");
      await pg.addMember(wsId, bystanderId, "member");
      await pg.createCybo({
        id: cyboId,
        workspaceId: wsId,
        slug: "rick",
        name: "Rick",
        soul: "You are Rick.",
        provider: "pi",
        createdBy: localUserId,
      });
      await pg.createChannel(generalChId, wsId, "general", localUserId);
      // Both humans + the cybo are #general members, so a leaked post would be broadly
      // visible (and the channel-member-gated relay broadcast can resolve recipients).
      await pg.addCyboToChannel(generalChId, cyboId);
    });

    afterAll(async () => {
      await getPool().query("DELETE FROM workspaces WHERE id = $1", [wsId]);
      await getPool().query("DELETE FROM users WHERE id = ANY($1::text[])", [
        [localUserId, cloudUserId, bystanderId],
      ]);
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
      await closePool();
    });

    // ── THE PROOF: a cloud DM to a channel-bound cybo must NOT leak ───

    it("a cloud DM to a channel-bound cybo stays a DM — zero leak into #general", async () => {
      const replyText = `private answer ${randomUUID()}`;
      installLeakingProvider(replyText);

      // Drive the CLOUD path: the relay forwards an agent_prompt_forward carrying
      // dmRecipient (= the requesting CLOUD user + email); the daemon routes it via
      // routeForwardedPrompt. The provider's turn ACTIVELY tries to leak to #general.
      await routeForwardedPrompt({
        agentId: cyboAgentId,
        prompt: "hey Rick, privately: what's the plan?",
        dmRecipient: { userId: cloudUserId, email: userEmail },
      });

      // The reply is persisted with channelId NULL (DM scope), from the cybo — the
      // relay flush is async, so poll PG.
      await waitFor(() => pgDmReply(replyText), "DM (channelId-null) reply persisted to PG");

      // PROOF: #general has ZERO messages from the cybo for this turn — even though
      // the stub provider EXPLICITLY called cyborg7_send_message({channel}) AND
      // emitted a channel-tagged stream. Both leak vectors were redirected.
      expect(await pgChannelMsgCountFromCybo(replyText)).toBe(0);

      // The relay's guest broadcast was a DM addressed to the requester, never a
      // channel post.
      const replyBroadcasts = relayBroadcasts.filter((b) => b.payload?.text === replyText);
      expect(replyBroadcasts.some((b) => b.type === "cyborg:channel_message_broadcast")).toBe(
        false,
      );
      const dmBroadcast = replyBroadcasts.find((b) => b.type === "cyborg:dm_broadcast");
      expect(dmBroadcast).toBeDefined();
      expect(dmBroadcast!.payload.toId).toBe(localUserId);
    });

    // ── NEGATIVE / baseline: a genuine channel mention STILL posts ───

    it("a genuine channel-mention turn still posts to #general (fix doesn't over-block)", async () => {
      const replyText = `standup report ${randomUUID()}`;
      installLeakingProvider(replyText);

      // No dmRecipient on the forward → a normal (non-DM) channel turn. The DM guard
      // is NEVER armed, so the cybo's stream-flush reply lands in #general as intended.
      await routeForwardedPrompt({
        agentId: mentionAgentId,
        prompt: "@Rick give the standup",
        // dmRecipient intentionally omitted — this is a channel turn.
      });

      // The legit reply IS persisted into #general (the relay flush is async).
      await waitFor(
        async () => ((await pgChannelMsgCountFromCybo(replyText)) > 0 ? true : undefined),
        "channel reply persisted to #general",
      );
      expect(await pgChannelMsgCountFromCybo(replyText)).toBeGreaterThanOrEqual(1);

      // And it was NOT redirected into a DM — neither persisted DM-scoped nor
      // broadcast as a DM. The relay re-broadcast the reply to the CHANNEL.
      expect(await pgDmReply(replyText)).toBeUndefined();
      const replyBroadcasts = relayBroadcasts.filter((b) => b.payload?.text === replyText);
      expect(replyBroadcasts.some((b) => b.type === "cyborg:dm_broadcast")).toBe(false);
      expect(replyBroadcasts.some((b) => b.type === "cyborg:channel_message_broadcast")).toBe(true);
    });
  },
);
