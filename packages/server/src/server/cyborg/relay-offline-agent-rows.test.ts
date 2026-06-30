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

  it("offlineBindingVisible: channel-bound (non-ephemeral) sessions are visible to anyone", () => {
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
    };
    // A NON-initiator (different email, no matching global id) still sees a shared
    // (non-ephemeral) channel agent.
    expect(offlineBindingVisible(b, "someone-else@test.dev", "viewer-global-9")).toBe(true);
    expect(offlineBindingVisible(b, null, null)).toBe(true);
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

  it("agentBindingVisibleCore: autonomous channel session is owner-scoped on the LIVE (id-space) path too", () => {
    // The daemon's handleListAgents calls this same predicate with an id-space
    // ownership check. An autonomous channel-bound session must be visible ONLY to
    // its initiator there as well — so live + offline lists can never disagree.
    const autonomousChannel = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      ephemeral: false,
      autonomous: true,
    };
    expect(agentBindingVisibleCore(autonomousChannel, () => true)).toBe(true); // owner (id match)
    expect(agentBindingVisibleCore(autonomousChannel, () => false)).toBe(false); // a peer
    // A human-spawned (non-autonomous) channel agent stays shared for the peer.
    const interactiveChannel = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      ephemeral: false,
      autonomous: false,
    };
    expect(agentBindingVisibleCore(interactiveChannel, () => false)).toBe(true);
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
      binding({ agentId: "a-channel", channelId: "chan-1", initiatedByEmail: "x@test.dev" }),
      binding({ agentId: "a-other", channelId: null, initiatedByEmail: "other@test.dev" }),
    ];
    // No live daemon answered (empty live set) — the relay falls back entirely to PG.
    const rows = offlineAgentRows(bindings, "owner@test.dev", new Set(), "owner-global");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toContain("a-own"); // own private session
    expect(ids).toContain("a-channel"); // channel-bound, everyone sees it
    expect(ids).not.toContain("a-other"); // someone else's private session stays hidden
  });

  it("hides another member's AUTONOMOUS (cron) channel session, but shows it to its scheduler", () => {
    // Seb scheduled "Rick" market-brief crons (autonomous, channel-bound). Rodrigo
    // must NOT see them in his sidebar; Seb still does.
    const bindings = [
      binding({
        agentId: "rick-cron",
        channelId: "chan-market",
        initiatedBy: "seb-local",
        initiatedByEmail: "seb@cyborg7.com",
        autonomous: true,
      }),
      // A genuinely human-spawned shared channel agent (autonomous false) stays
      // visible to every member — the collaborative feature is preserved.
      binding({
        agentId: "shared-helper",
        channelId: "chan-market",
        initiatedBy: "seb-local",
        initiatedByEmail: "seb@cyborg7.com",
      }),
    ];
    // Rodrigo (a peer) — sees only the shared interactive agent, NOT Seb's cron.
    const rodrigo = offlineAgentRows(bindings, "rodrigo@cyborg7.com", new Set(), "rodrigo-global");
    expect(rodrigo.map((r) => r.agentId)).toEqual(["shared-helper"]);
    // Seb (the scheduler) — sees BOTH his cron and the shared agent.
    const seb = offlineAgentRows(bindings, "seb@cyborg7.com", new Set(), "seb-global");
    expect(seb.map((r) => r.agentId).sort()).toEqual(["rick-cron", "shared-helper"]);
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

    it("a SHARED (non-ephemeral) channel agent is clearable by ANY member", () => {
      expect(
        canClearAgentBinding(
          { channelId: "chan-1", initiatedBy: "global-owner", initiatedByEmail: "owner@test.dev" },
          { userId: "global-someone-else", email: "member@test.dev", role: "member" },
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
      // STRICTER than canClearAgentBinding: a channel-bound session is NOT readable
      // by any workspace member, only by ACTUAL channel members.
      expect(
        canReadAgentSession(channelBinding, {
          userId: "global-stranger",
          email: "stranger@test.dev",
          role: "member",
          isChannelMember: false,
        }),
      ).toBe(false);
    });

    it("ALLOWS a member of the session's channel", () => {
      expect(
        canReadAgentSession(channelBinding, {
          userId: "global-member",
          email: "member@test.dev",
          role: "member",
          isChannelMember: true,
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

    it("never touches a SHARED (non-autonomous) channel agent -- trusts the daemon scoping", () => {
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
      ).toHaveLength(1);
    });

    it("keeps a live row absent from the mirror (fresh spawn) -- no false-negative", () => {
      expect(
        filterLiveRowsForViewer([row("fresh-1")], new Map(), "rodrigo@test.dev", "rodrigo-global"),
      ).toHaveLength(1);
    });
  });
});
