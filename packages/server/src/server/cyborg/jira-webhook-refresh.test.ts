import { describe, it, expect, vi } from "vitest";
import {
  refreshDueJiraWebhooks,
  startJiraWebhookRefreshScheduler,
  type RefreshDueDeps,
} from "./jira-webhook-refresh.js";
import type { PgSync, StoredIntegrationInstallation } from "./db/pg-sync.js";
import type { JiraWebhookRefreshResult } from "./integrations/jira-adapter.js";

// Drive the refresh sweep over injected deps (no network, no token crypto): the sweep reads
// each install's config.webhooks, refreshes ONLY records within the 7-day threshold, writes
// the new expiry back, and stays best-effort per install.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const NEW_EXPIRY = "2026-08-01T00:00:00.000Z";

function install(
  id: string,
  externalId: string,
  webhooks: Record<string, { webhookIds: number[]; expiresAt: number }>,
): StoredIntegrationInstallation {
  return {
    id,
    workspaceId: `ws_${id}`,
    provider: "jira",
    externalId,
    config: { webhooks },
    accessToken: null,
    botUserId: null,
    scopes: null,
    installedBy: "u_1",
    createdAt: 1,
  };
}

// A minimal pg the sweep touches only for the re-read + persist of a changed install.
function makePg(installs: StoredIntegrationInstallation[]): {
  pg: PgSync;
  upserts: Array<Record<string, unknown>>;
} {
  const byId = new Map(installs.map((i) => [i.id, i]));
  const upserts: Array<Record<string, unknown>> = [];
  const pg = {
    async getIntegrationInstallationById(id: string) {
      return byId.get(id) ?? null;
    },
    async upsertIntegrationInstallation(opts: Record<string, unknown>) {
      upserts.push(opts);
      return String(opts.id);
    },
  } as unknown as PgSync;
  return { pg, upserts };
}

describe("refreshDueJiraWebhooks", () => {
  it("refreshes ONLY near-expiry webhooks, updates the stored expiry, and is best-effort", async () => {
    const installA = install("intg_a", "cidA", {
      "cidA:ENG": { webhookIds: [1], expiresAt: NOW + 3 * DAY }, // DUE (<7d)
      "cidA:OPS": { webhookIds: [2], expiresAt: NOW + 20 * DAY }, // NOT due
    });
    const installB = install("intg_b", "cidB", {
      "cidB:MKT": { webhookIds: [3], expiresAt: NOW + 2 * DAY }, // DUE but token unavailable
    });
    const installC = install("intg_c", "cidC", {}); // nothing registered
    const { pg, upserts } = makePg([installA, installB, installC]);

    const refreshCalls: number[][] = [];
    const deps: RefreshDueDeps = {
      now: () => NOW,
      listInstalls: async () => [installA, installB, installC],
      resolveToken: async (_pg, i) => (i.id === "intg_b" ? null : "tok"),
      refreshWebhooks: async (
        _token: string,
        _cloudId: string,
        ids: number[],
      ): Promise<JiraWebhookRefreshResult> => {
        refreshCalls.push(ids);
        return { ok: true, webhookIds: ids, expirationDate: NEW_EXPIRY };
      },
    };

    const summary = await refreshDueJiraWebhooks(pg, deps);

    expect(summary.installs).toBe(3);
    expect(summary.dueWebhooks).toBe(2); // A:ENG + B:MKT (A:OPS is far off; C has none)
    expect(summary.refreshed).toBe(1); // only A:ENG
    expect(summary.failed).toBe(1); // B:MKT — no token
    // refreshWebhooks was called ONLY for the due webhook of the install that had a token.
    expect(refreshCalls).toEqual([[1]]);

    // Exactly one persist (install A), carrying the refreshed ENG expiry + the untouched OPS.
    expect(upserts).toHaveLength(1);
    const persisted = (upserts[0]!.config as {
      webhooks: Record<string, { webhookIds: number[]; expiresAt: number }>;
    }).webhooks;
    expect(persisted["cidA:ENG"]).toEqual({ webhookIds: [1], expiresAt: Date.parse(NEW_EXPIRY) });
    expect(persisted["cidA:OPS"]).toEqual({ webhookIds: [2], expiresAt: NOW + 20 * DAY });
  });

  it("captures a refresh-API failure without persisting that record (best-effort)", async () => {
    const installA = install("intg_a", "cidA", {
      "cidA:ENG": { webhookIds: [1], expiresAt: NOW + 1 * DAY }, // DUE
    });
    const { pg, upserts } = makePg([installA]);

    const summary = await refreshDueJiraWebhooks(pg, {
      now: () => NOW,
      listInstalls: async () => [installA],
      resolveToken: async () => "tok",
      refreshWebhooks: async (): Promise<JiraWebhookRefreshResult> => ({
        ok: false,
        status: 404,
        error: "refresh failed: 404 Not Found",
      }),
    });

    expect(summary.dueWebhooks).toBe(1);
    expect(summary.refreshed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toContain("404");
    // Nothing changed → no persist.
    expect(upserts).toHaveLength(0);
  });

  it("returns an empty summary (no throw) when listing installs fails", async () => {
    const { pg } = makePg([]);
    const summary = await refreshDueJiraWebhooks(pg, {
      now: () => NOW,
      listInstalls: async () => {
        throw new Error("db down");
      },
    });
    expect(summary.installs).toBe(0);
    expect(summary.refreshed).toBe(0);
    expect(summary.errors[0]).toContain("db down");
  });
});

describe("startJiraWebhookRefreshScheduler", () => {
  it("returns a stoppable handle without firing synchronously", () => {
    const { pg } = makePg([]);
    const handle = startJiraWebhookRefreshScheduler(pg);
    expect(typeof handle.stop).toBe("function");
    // Nothing ran on start (the sweep only fires on the daily interval).
    handle.stop();
  });
});

// Keep the vi import referenced even if a future edit drops its only use.
void vi;
