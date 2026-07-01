import { describe, it, expect } from "vitest";
import {
  agentBindingVisibleCore,
  buildOfflineAgentRow,
  offlineBindingVisible,
  offlineAgentRows,
  filterLiveRowsForViewer,
  auditAgentRows,
  shouldGcOwnerBindings,
  canClearAgentBinding,
  canReadAgentSession,
  isPromptFromInitiatorForward,
  isAuthorizedInitiator,
  resolveOwnerArchiveRoute,
  type OfflineAgentBinding,
} from "./relay-offline-agent-rows.js";

function binding(overrides: Partial<OfflineAgentBinding> = {}): OfflineAgentBinding {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    channelId: null,
    provider: "claude",
    model: "claude-sonnet-4",
    systemPrompt: null,
    daemonId: "daemon-A",
    cyboId: null,
    initiatedBy: "local-user-1",
    initiatedByEmail: "owner@test.dev",
    cwd: "/home/owner/project",
    providerSessionId: "sess-abc",
    ...overrides,
  };
}

describe("relay-offline-agent-rows", () => {
  it("buildOfflineAgentRow renders a non-live row (daemon offline) matching the daemon shape", () => {
    const row = buildOfflineAgentRow(binding());
    expect(row).toMatchObject({
      agentId: "agent-1",
      provider: "claude",
      channelId: null,
      cyboId: null,
      cyboName: null,
      cyboAvatar: null,
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
      // Same projection as the daemon's liveAgentFields no-live branch.
      lifecycle: "unknown",
      model: "claude-sonnet-4",
      modeId: null,
      thinkingOptionId: null,
      cwd: "/home/owner/project",
      // The owning daemon is offline — this is the whole point of the fallback.
      daemonLocal: false,
      daemonId: "daemon-A",
    });
    expect(row.availableModes).toEqual([]);
  });

  it("offlineBindingVisible: channel-bound sessions are OWNER-SCOPED (private, not shared)", () => {
    // PRIVACY (2026-06-30): a channel-bound cybo session is private to its
    // initiator; a member no longer sees another member's channel cybo session.
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
    };
    // The initiator sees their own session…
    expect(offlineBindingVisible(b, "owner@test.dev", null)).toBe(true);
    // …but a NON-initiator (different email, no matching global id) does NOT.
    expect(offlineBindingVisible(b, "someone-else@test.dev", "viewer-global-9")).toBe(false);
    expect(offlineBindingVisible(b, null, null)).toBe(false);
  });

  it("offlineBindingVisible: a channel-bound EPHEMERAL session is owner-scoped (NOT shared)", () => {
    // The ephemeral mention-session ownership leak: a channel-bound ephemeral summon
    // belongs to the user who triggered it and must NOT leak to other members the way
    // a (non-ephemeral) shared channel agent does.
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
      ephemeral: true,
    };
    expect(offlineBindingVisible(b, "owner@test.dev", null)).toBe(true); // the owner sees it
    expect(offlineBindingVisible(b, "someone-else@test.dev", "viewer-9")).toBe(false); // others do NOT
    expect(offlineBindingVisible(b, null, null)).toBe(false);
  });

  it("offlineBindingVisible: a channel-bound AUTONOMOUS (cron) session is owner-scoped (NOT shared)", () => {
    // The cron-session leak (Rodrigo seeing Seb's "Rick" market-brief crons): a
    // scheduled cybo is channel-bound + non-ephemeral, so it slipped through the
    // "shared channel agent" short-circuit into every member's sidebar. An
    // autonomous session belongs PRIVATELY to whoever scheduled it.
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
      autonomous: true,
    };
    expect(offlineBindingVisible(b, "owner@test.dev", null)).toBe(true); // the scheduler sees it
    expect(offlineBindingVisible(b, "someone-else@test.dev", "viewer-9")).toBe(false); // others do NOT
    expect(offlineBindingVisible(b, null, null)).toBe(false);
  });

  it("agentBindingVisibleCore: EVERY channel-bound session is owner-scoped on the LIVE (id-space) path", () => {
    // The daemon's handleListAgents calls this same predicate with an id-space
    // ownership check. PRIVACY (2026-06-30): ALL channel-bound sessions (autonomous
    // or human-spawned interactive) are visible ONLY to their initiator — so live +
    // offline lists can never disagree, and no member sees another's cybo session.
    const autonomousChannel = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      ephemeral: false,
      autonomous: true,
    };
    expect(agentBindingVisibleCore(autonomousChannel, () => true)).toBe(true); // owner (id match)
    expect(agentBindingVisibleCore(autonomousChannel, () => false)).toBe(false); // a peer
    // A human-spawned (non-autonomous) channel agent is now owner-scoped too: a peer
    // no longer sees it (the shared-channel short-circuit was removed).
    const interactiveChannel = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      ephemeral: false,
      autonomous: false,
    };
    expect(agentBindingVisibleCore(interactiveChannel, () => true)).toBe(true); // owner
    expect(agentBindingVisibleCore(interactiveChannel, () => false)).toBe(false); // a peer
  });

  it("offlineBindingVisible: a session with no initiator is visible", () => {
    const b = { channelId: null, initiatedBy: null, initiatedByEmail: null };
    expect(offlineBindingVisible(b, "anyone@test.dev", "anyone-global")).toBe(true);
  });

  it("offlineBindingVisible: a PRIVATE session shows only to its initiator (case-insensitive email match)", () => {
    const b = { channelId: null, initiatedBy: "local-1", initiatedByEmail: "Owner@Test.dev" };
    expect(offlineBindingVisible(b, "owner@test.dev", null)).toBe(true);
    expect(offlineBindingVisible(b, "intruder@test.dev", "intruder-global")).toBe(false);
    // No identity to compare against → not visible (never leak a private session).
    expect(offlineBindingVisible(b, null, null)).toBe(false);
  });

  it("offlineBindingVisible: a PRIVATE session matches its owner by GLOBAL id when the email is the synthetic @remote.local placeholder (#810)", () => {
    // OLD cross-daemon row: the mirror only ever stored the fake placeholder email,
    // but initiated_by carries the cloud GLOBAL account id (bootstrap stamps it on
    // the forward path). The owner is re-attributed by id, not the unmatchable email.
    const b = {
      channelId: null,
      initiatedBy: "global-acct-4871b232",
      initiatedByEmail: "global-acct-4871b232@remote.local",
    };
    // The owner (their global id == initiated_by) sees their own private session…
    expect(offlineBindingVisible(b, "owner@cyborg7.com", "global-acct-4871b232")).toBe(true);
    // …but a different account (different global id, fake email never matches) does NOT.
    expect(offlineBindingVisible(b, "intruder@cyborg7.com", "global-acct-9999")).toBe(false);
    expect(offlineBindingVisible(b, null, null)).toBe(false);
  });

  it("offlineBindingVisible: a PRIVATE session matches its owner by REAL email even when the global id differs (own-daemon row)", () => {
    // Own-daemon session: initiated_by is a LOCAL SQLite id (≠ the viewer's global
    // id), but the mirror now stores the REAL email — so the email path admits it.
    const b = {
      channelId: null,
      initiatedBy: "local-sqlite-7d83",
      initiatedByEmail: "owner@cyborg7.com",
    };
    expect(offlineBindingVisible(b, "owner@cyborg7.com", "global-acct-4871b232")).toBe(true);
    expect(offlineBindingVisible(b, "intruder@cyborg7.com", "global-acct-9999")).toBe(false);
  });

  it("lists a workspace's sessions from PG when the owning daemon is offline (no live agent)", () => {
    const bindings = [
      binding({ agentId: "a-own", initiatedByEmail: "owner@test.dev", channelId: null }),
      // My OWN channel-bound session — visible to me (the initiator).
      binding({ agentId: "a-my-channel", channelId: "chan-1", initiatedByEmail: "owner@test.dev" }),
      // Another user's channel-bound session — PRIVACY (2026-06-30): now owner-scoped,
      // so it must NOT leak into my list.
      binding({ agentId: "a-channel", channelId: "chan-1", initiatedByEmail: "x@test.dev" }),
      binding({ agentId: "a-other", channelId: null, initiatedByEmail: "other@test.dev" }),
    ];
    // No live daemon answered (empty live set) — the relay falls back entirely to PG.
    const rows = offlineAgentRows(bindings, "owner@test.dev", new Set(), "owner-global");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toContain("a-own"); // own private session
    expect(ids).toContain("a-my-channel"); // own channel-bound session
    expect(ids).not.toContain("a-channel"); // another user's channel session — no longer shared
    expect(ids).not.toContain("a-other"); // someone else's private session stays hidden
  });

  it("hides another member's channel sessions (cron AND interactive), but shows them to their initiator", () => {
    // PRIVACY (2026-06-30): Seb's channel cybo sessions — a "Rick" market-brief cron
    // (autonomous) AND a human-spawned interactive channel agent — are BOTH private
    // to Seb now. Rodrigo (a peer) must see NEITHER in his sidebar; Seb sees both.
    const bindings = [
      binding({
        agentId: "rick-cron",
        channelId: "chan-market",
        initiatedBy: "seb-local",
        initiatedByEmail: "seb@cyborg7.com",
        autonomous: true,
      }),
      // A human-spawned interactive channel agent — now owner-scoped too (the
      // shared-channel short-circuit was removed).
      binding({
        agentId: "seb-helper",
        channelId: "chan-market",
        initiatedBy: "seb-local",
        initiatedByEmail: "seb@cyborg7.com",
      }),
    ];
    // Rodrigo (a peer) — sees NONE of Seb's channel sessions.
    const rodrigo = offlineAgentRows(bindings, "rodrigo@cyborg7.com", new Set(), "rodrigo-global");
    expect(rodrigo.map((r) => r.agentId)).toEqual([]);
    // Seb (the initiator) — sees BOTH his cron and his interactive channel agent.
    const seb = offlineAgentRows(bindings, "seb@cyborg7.com", new Set(), "seb-global");
    expect(seb.map((r) => r.agentId).sort()).toEqual(["rick-cron", "seb-helper"]);
  });

  it("lists an OLD @remote.local private row to its owner by GLOBAL id, but hides a peer's (#810)", () => {
    const bindings = [
      // Owner's own DM session, mirrored before the real-email fix → fake email only.
      binding({
        agentId: "a-mine",
        channelId: null,
        initiatedBy: "global-me",
        initiatedByEmail: "global-me@remote.local",
      }),
      // A peer's private DM session, likewise only a fake email.
      binding({
        agentId: "a-peer",
        channelId: null,
        initiatedBy: "global-peer",
        initiatedByEmail: "global-peer@remote.local",
      }),
    ];
    const rows = offlineAgentRows(bindings, "me@cyborg7.com", new Set(), "global-me");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toContain("a-mine"); // re-attributed to me by global id
    expect(ids).not.toContain("a-peer"); // peer's private session does NOT leak
  });

  it("dedupes against the live fan-out — a live agent's daemon row wins", () => {
    const bindings = [
      binding({ agentId: "a-live", initiatedByEmail: "owner@test.dev" }),
      binding({ agentId: "a-offline", initiatedByEmail: "owner@test.dev" }),
    ];
    const rows = offlineAgentRows(bindings, "owner@test.dev", new Set(["a-live"]), "owner-global");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toEqual(["a-offline"]);
  });

  // ─── Daemon-owner audit offline fallback (#993) ──────────────────────
  it("auditAgentRows returns ALL sessions on the daemon — incl. other users' — with NO guestEmail scoping", () => {
    const bindings = [
      binding({ agentId: "a-own", initiatedByEmail: "owner@test.dev", daemonId: "daemon-A" }),
      binding({ agentId: "a-other", initiatedByEmail: "other@test.dev", daemonId: "daemon-A" }),
    ];
    const rows = auditAgentRows(bindings, "daemon-A");
    const ids = rows.map((r) => r.agentId).sort();
    // Both — the per-user offlineBindingVisible filter is NOT applied here.
    expect(ids).toEqual(["a-other", "a-own"]);
    for (const r of rows) {
      expect(r.ephemeral).toBe(false);
      expect(r.internal).toBe(false);
    }
  });

  it("auditAgentRows surfaces the ephemeral badge when a binding carries it", () => {
    const bindings = [binding({ agentId: "a-eph", daemonId: "daemon-A", ephemeral: true })];
    const rows = auditAgentRows(bindings, "daemon-A");
    expect(rows[0].ephemeral).toBe(true);
  });

  it("auditAgentRows filters to the target daemon only", () => {
    const bindings = [
      binding({ agentId: "on-A", daemonId: "daemon-A" }),
      binding({ agentId: "on-B", daemonId: "daemon-B" }),
    ];
    const rows = auditAgentRows(bindings, "daemon-A");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toEqual(["on-A"]);
  });

  // ─── Stale-binding GC eligibility (#810 hardening) ───────────────────
  it("shouldGcOwnerBindings: runs ONLY on an UNFILTERED, NON-EMPTY list", () => {
    expect(shouldGcOwnerBindings({ requestFiltered: false, liveAgentCount: 2 })).toBe(true);
    expect(shouldGcOwnerBindings({ requestFiltered: false, liveAgentCount: 1 })).toBe(true);
  });

  it("shouldGcOwnerBindings: SKIPS a FILTERED (cyboId) list — it's a subset, not the complete set", () => {
    // The dangerous case the review caught: a cyboId-scoped list_agents would
    // otherwise prune the owner's OTHER live cybo bindings.
    expect(shouldGcOwnerBindings({ requestFiltered: true, liveAgentCount: 2 })).toBe(false);
    expect(shouldGcOwnerBindings({ requestFiltered: true, liveAgentCount: 0 })).toBe(false);
  });

  it("shouldGcOwnerBindings: SKIPS an EMPTY response (ambiguous/transient — never delete-all)", () => {
    expect(shouldGcOwnerBindings({ requestFiltered: false, liveAgentCount: 0 })).toBe(false);
  });

  // ─── Archive/clear authorization (shared by the ONLINE owner-archive bypass and
  //     the OFFLINE clear path) ───────────────────────────────────────────────
  describe("canClearAgentBinding", () => {
    const privateBinding = {
      channelId: null,
      initiatedBy: "global-owner",
      initiatedByEmail: "owner@test.dev",
    };

    it("a workspace OWNER (non-initiator) CAN clear a PRIVATE session — the online-daemon regression case", () => {
      // The bug: owner archives a session running on a daemon they don't own; the
      // spawn-scope gate rejected them. The predicate now admits the owner.
      expect(
        canClearAgentBinding(privateBinding, {
          userId: "global-someone-else",
          email: "admin@test.dev",
          role: "owner",
        }),
      ).toBe(true);
    });

    it("an ADMIN (non-initiator) CAN clear a PRIVATE session", () => {
      expect(
        canClearAgentBinding(privateBinding, {
          userId: "global-someone-else",
          email: "admin2@test.dev",
          role: "admin",
        }),
      ).toBe(true);
    });

    it("a non-owner/non-admin NON-initiator member CANNOT clear a PRIVATE session", () => {
      expect(
        canClearAgentBinding(privateBinding, {
          userId: "global-someone-else",
          email: "member@test.dev",
          role: "member",
        }),
      ).toBe(false);
    });

    it("the INITIATOR (matched by email, case-insensitive) CAN clear their own PRIVATE session", () => {
      expect(
        canClearAgentBinding(
          { channelId: null, initiatedBy: "local-x", initiatedByEmail: "Owner@Test.dev" },
          { userId: "global-different", email: "owner@test.dev", role: "member" },
        ),
      ).toBe(true);
    });

    it("the INITIATOR matched by GLOBAL id (initiated_by) CAN clear, even when the email does not match (#810)", () => {
      expect(
        canClearAgentBinding(
          {
            channelId: null,
            initiatedBy: "global-acct-4871",
            initiatedByEmail: "global-acct-4871@remote.local",
          },
          { userId: "global-acct-4871", email: "owner@cyborg7.com", role: "member" },
        ),
      ).toBe(true);
    });

    it("a channel-bound session is NOT clearable by a non-initiator member (privacy: no global teardown)", () => {
      // PRIVACY (2026-06-30): channelId no longer short-circuits to allow any member.
      // A non-owner/non-initiator can no longer archive+kill another user's channel
      // cybo session.
      expect(
        canClearAgentBinding(
          { channelId: "chan-1", initiatedBy: "global-owner", initiatedByEmail: "owner@test.dev" },
          { userId: "global-someone-else", email: "member@test.dev", role: "member" },
        ),
      ).toBe(false);
    });

    it("a channel-bound session IS clearable by its initiator", () => {
      expect(
        canClearAgentBinding(
          { channelId: "chan-1", initiatedBy: "global-owner", initiatedByEmail: "owner@test.dev" },
          { userId: "global-owner", email: "owner@test.dev", role: "member" },
        ),
      ).toBe(true);
    });

    it("a channel-bound session IS clearable by a workspace OWNER/ADMIN (clear clutter)", () => {
      expect(
        canClearAgentBinding(
          { channelId: "chan-1", initiatedBy: "global-owner", initiatedByEmail: "owner@test.dev" },
          { userId: "global-admin", email: "admin@test.dev", role: "admin" },
        ),
      ).toBe(true);
    });

    it("role null (not a member) + non-initiator + private ⇒ CANNOT clear", () => {
      expect(
        canClearAgentBinding(privateBinding, {
          userId: "global-someone-else",
          email: "stranger@test.dev",
          role: null,
        }),
      ).toBe(false);
    });
  });

  // ─── Session-read authorization (relay-side IDOR gate) ──────────────────────
  describe("canReadAgentSession", () => {
    const channelBinding = {
      channelId: "chan-1",
      initiatedBy: "global-init",
      initiatedByEmail: "init@test.dev",
    };
    const privateBinding = {
      channelId: null,
      initiatedBy: "global-init",
      initiatedByEmail: "init@test.dev",
    };

    it("DENIES a non-member of the session's channel (the IDOR case)", () => {
      // A channel-bound session is OWNER-SCOPED — readable only by its initiator or
      // an admin, never by mere workspace membership.
      expect(
        canReadAgentSession(channelBinding, {
          userId: "global-stranger",
          email: "stranger@test.dev",
          role: "member",
          isChannelMember: false,
        }),
      ).toBe(false);
    });

    // PRIVACY (2026-06-30): channel-bound cybo sessions are OWNER-SCOPED. Channel
    // MEMBERSHIP no longer grants a read — only the initiator or an admin. (Reverses
    // the earlier "channel member can read" assertion.)
    it("DENIES a channel MEMBER who is neither initiator nor admin (owner-scoped now)", () => {
      expect(
        canReadAgentSession(channelBinding, {
          userId: "global-member",
          email: "member@test.dev",
          role: "member",
          isChannelMember: true,
        }),
      ).toBe(false);
    });

    it("ALLOWS the initiator of a channel-bound session (email-bridged)", () => {
      expect(
        canReadAgentSession(channelBinding, {
          userId: "global-different",
          email: "Init@Test.dev",
          role: "member",
          isChannelMember: false,
        }),
      ).toBe(true);
    });

    it("ALLOWS the initiator (email-bridged) of a PRIVATE session, no channel", () => {
      expect(
        canReadAgentSession(privateBinding, {
          userId: "global-different",
          email: "Init@Test.dev",
          role: "member",
          isChannelMember: false,
        }),
      ).toBe(true);
    });

    it("ALLOWS the initiator matched by GLOBAL id (#810 bridge)", () => {
      expect(
        canReadAgentSession(
          { channelId: null, initiatedBy: "acct-9", initiatedByEmail: "acct-9@remote.local" },
          { userId: "acct-9", email: "real@test.dev", role: "member", isChannelMember: false },
        ),
      ).toBe(true);
    });

    it("ALLOWS a workspace OWNER/ADMIN to read any session (audit)", () => {
      expect(
        canReadAgentSession(privateBinding, {
          userId: "global-admin",
          email: "admin@test.dev",
          role: "owner",
          isChannelMember: false,
        }),
      ).toBe(true);
    });

    it("DENIES a non-initiator, non-admin, non-member for a PRIVATE session", () => {
      expect(
        canReadAgentSession(privateBinding, {
          userId: "global-nobody",
          email: "nobody@test.dev",
          role: "member",
          isChannelMember: false,
        }),
      ).toBe(false);
    });
  });

  // ─── Cloud DRIVE gate: only the initiator can prompt a session ──────────────
  // The relay gates send_agent_prompt on workspace-membership + chat scope ONLY,
  // then injects agent_prompt_forward — so the daemon's isPromptFromInitiatorForward
  // is the SOLE initiator gate on the cloud drive path. This is the exact hole the
  // incident exploited: a channel member with chat scope driving another user's
  // channel-bound cybo. (FIX C — covers the gap that let the shared-channel bypass
  // slip through the read-only tests.)
  describe("isPromptFromInitiatorForward (cloud drive gate)", () => {
    // A channel-bound, non-ephemeral session owned by Seb.
    const channelBinding = { initiatedBy: "seb-local" };
    const sebEmail = "seb@cyborg7.com";

    it("DENIES a non-initiator channel member (chat scope) driving Seb's channel-bound session", () => {
      // Rodrigo is a channel member with chat scope — the incident hijacker. His cloud
      // id ≠ initiated_by AND his email ≠ Seb's ⇒ DENIED. (Pre-fix: the isSharedChannelAgent
      // short-circuit returned true here.)
      expect(
        isPromptFromInitiatorForward(channelBinding, sebEmail, {
          fromUserId: "rodrigo-cloud",
          fromEmail: "rodrigo@cyborg7.com",
        }),
      ).toBe(false);
    });

    it("ALLOWS the initiator matched by cloud id (== initiated_by)", () => {
      expect(
        isPromptFromInitiatorForward({ initiatedBy: "seb-cloud" }, sebEmail, {
          fromUserId: "seb-cloud",
          fromEmail: sebEmail,
        }),
      ).toBe(true);
    });

    it("ALLOWS the owner via the email bridge (local initiated_by ≠ cloud fromUserId)", () => {
      // The #810 divergence: initiated_by is Seb's LOCAL SQLite id, fromUserId is his
      // CLOUD id — different strings, same person. Bridged by canonical email.
      expect(
        isPromptFromInitiatorForward(channelBinding, sebEmail, {
          fromUserId: "seb-cloud-different",
          fromEmail: "Seb@Cyborg7.com", // case-insensitive
        }),
      ).toBe(true);
    });

    it("DENIES fail-closed when the forward carries no identity (legacy guest path)", () => {
      // guest_prompt_agent forwards without fromUserId/fromEmail — can't prove initiator.
      expect(
        isPromptFromInitiatorForward(channelBinding, sebEmail, {}),
      ).toBe(false);
    });

    it("ALLOWS when the session has no recorded initiator (nobody to restrict)", () => {
      expect(
        isPromptFromInitiatorForward({ initiatedBy: null }, null, {
          fromUserId: "anyone",
          fromEmail: "anyone@test.dev",
        }),
      ).toBe(true);
    });
  });

  // ─── Owner-archive routing (the live-session reappearing-row fix) ───────────
  describe("resolveOwnerArchiveRoute", () => {
    it("ONLINE owning daemon ⇒ 'daemon' (authoritative forward, NOT a PG-only clear)", () => {
      // The bug: clearing only PG let the still-online daemon re-advertise the live
      // agent on the next list_agents fan-out, so the archived row reappeared. The
      // archive must be handled by the owning daemon (SQLite teardown + agent kill).
      expect(resolveOwnerArchiveRoute({ owningDaemonId: "daemon-a", daemonReachable: true })).toBe(
        "daemon",
      );
    });

    it("OFFLINE owning daemon ⇒ 'pg-clear' (the offline fallback is correct)", () => {
      expect(resolveOwnerArchiveRoute({ owningDaemonId: "daemon-a", daemonReachable: false })).toBe(
        "pg-clear",
      );
    });

    it("no resolvable owning daemon ⇒ 'pg-clear' (cannot aim the live teardown)", () => {
      expect(resolveOwnerArchiveRoute({ owningDaemonId: undefined, daemonReachable: true })).toBe(
        "pg-clear",
      );
      expect(resolveOwnerArchiveRoute({ owningDaemonId: undefined, daemonReachable: false })).toBe(
        "pg-clear",
      );
    });
  });
  // --- filterLiveRowsForViewer -- the LIVE-list IDOR re-filter ---
  describe("filterLiveRowsForViewer (live-list re-filter)", () => {
    type Mirror = Map<
      string,
      {
        channelId: string | null;
        initiatedBy: string | null;
        initiatedByEmail: string | null;
        autonomous: boolean;
      }
    >;
    const row = (id: string): Record<string, unknown> => ({ agentId: id, provider: "claude" });

    it("hides another member's AUTONOMOUS live session (the cron-leak vector)", () => {
      const mirror: Mirror = new Map([
        [
          "cron-1",
          {
            channelId: "chan-briefs",
            initiatedBy: "seb-local",
            initiatedByEmail: "seb@test.dev",
            autonomous: true,
          },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("cron-1")], mirror, "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(0);
    });

    it("keeps the OWNER's own autonomous session (matched by email, case-insensitive)", () => {
      const mirror: Mirror = new Map([
        [
          "cron-1",
          {
            channelId: "chan-briefs",
            initiatedBy: "seb-local",
            initiatedByEmail: "seb@test.dev",
            autonomous: true,
          },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("cron-1")], mirror, "Seb@test.dev", "seb-global"),
      ).toHaveLength(1);
    });

    it("keeps the OWNER's own autonomous session (matched by global id == initiated_by)", () => {
      const mirror: Mirror = new Map([
        [
          "cron-1",
          {
            channelId: "chan-briefs",
            initiatedBy: "seb-global",
            initiatedByEmail: null,
            autonomous: true,
          },
        ],
      ]);
      expect(filterLiveRowsForViewer([row("cron-1")], mirror, null, "seb-global")).toHaveLength(1);
    });

    it("DROPS a peer's NON-autonomous channel session -- the relay enforces owner-scoping without waiting for the owning daemon to update", () => {
      // The hole: the owning daemon on OLD code returns this human-spawned channel
      // session UNSCOPED and the relay merged it verbatim, so Rodrigo saw Seb's
      // session. The relay now applies agentBindingVisibleCore to it too.
      const mirror: Mirror = new Map([
        [
          "shared-1",
          {
            channelId: "chan-general",
            initiatedBy: "seb-local",
            initiatedByEmail: "seb@test.dev",
            autonomous: false,
          },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("shared-1")], mirror, "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(0);
    });

    it("KEEPS the owner's OWN non-autonomous channel session (email match, case-insensitive)", () => {
      const mirror: Mirror = new Map([
        [
          "shared-1",
          {
            channelId: "chan-general",
            initiatedBy: "seb-local",
            initiatedByEmail: "seb@test.dev",
            autonomous: false,
          },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("shared-1")], mirror, "Seb@test.dev", "seb-global"),
      ).toHaveLength(1);
    });

    it("KEEPS the owner's OWN non-autonomous channel session (global id == initiated_by)", () => {
      const mirror: Mirror = new Map([
        [
          "shared-1",
          {
            channelId: "chan-general",
            initiatedBy: "seb-global",
            initiatedByEmail: null,
            autonomous: false,
          },
        ],
      ]);
      expect(filterLiveRowsForViewer([row("shared-1")], mirror, null, "seb-global")).toHaveLength(1);
    });

    it("DROPS a peer's DM (non-channel) session too -- DM sessions are owner-scoped", () => {
      const mirror: Mirror = new Map([
        [
          "dm-1",
          {
            channelId: null,
            initiatedBy: "seb-local",
            initiatedByEmail: "seb@test.dev",
            autonomous: false,
          },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("dm-1")], mirror, "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(0);
    });

    it("KEEPS a mirrored row with NO initiator (legacy/system) for anyone", () => {
      const mirror: Mirror = new Map([
        [
          "legacy-1",
          { channelId: "chan-general", initiatedBy: null, initiatedByEmail: null, autonomous: false },
        ],
      ]);
      expect(
        filterLiveRowsForViewer([row("legacy-1")], mirror, "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(1);
    });

    it("keeps a live row absent from the mirror (fresh spawn OR ephemeral -- never mirrored) -- no false-negative", () => {
      expect(
        filterLiveRowsForViewer([row("fresh-1")], new Map(), "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(1);
    });
  });

  describe("isAuthorizedInitiator", () => {
    it("allows when ids match (same id-space)", () => {
      expect(
        isAuthorizedInitiator({ id: "u1", email: null }, { id: "u1", email: null }),
      ).toBe(true);
    });

    it("allows when emails match CASE-INSENSITIVELY across divergent ids", () => {
      expect(
        isAuthorizedInitiator(
          { id: "local-1", email: "Seb@X.com" },
          { id: "cloud-1", email: "seb@x.com" },
        ),
      ).toBe(true);
    });

    it("denies when emails differ (and ids differ)", () => {
      expect(
        isAuthorizedInitiator(
          { id: "local-1", email: "seb@x.com" },
          { id: "cloud-1", email: "rodrigo@x.com" },
        ),
      ).toBe(false);
    });

    it("denies when the initiator email is null even if the caller has one", () => {
      expect(
        isAuthorizedInitiator({ id: "local-1", email: null }, { id: "cloud-1", email: "seb@x.com" }),
      ).toBe(false);
    });

    it("denies when the caller email is null even if the initiator has one", () => {
      expect(
        isAuthorizedInitiator({ id: "local-1", email: "seb@x.com" }, { id: "cloud-1", email: null }),
      ).toBe(false);
    });

    it("denies when BOTH emails are null (nulls never collide)", () => {
      expect(
        isAuthorizedInitiator({ id: "local-1", email: null }, { id: "cloud-1", email: null }),
      ).toBe(false);
    });
  });
});
