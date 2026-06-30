import { describe, it, expect } from "vitest";
import { RECIPES } from "./registry.js";
import { PLATFORM_PERMISSIONS } from "../cybo-types.js";
import { validateScheduleCadence } from "../../schedule/cron.js";

// The recipe registry is the pure provisioning catalog: each recipe declares a
// cybo (preset soul + grants) and, via plan(config), the schedules + channel
// memberships to provision. These tests prove plan() yields a well-formed plan
// for every recipe — a valid cybo, only real platform-permission grants, valid
// crons, and the channel resolution the dispatcher relies on.

const PERM_SET = new Set<string>(PLATFORM_PERMISSIONS);

describe("RECIPES registry — plan() shape", () => {
  it("registers exactly the three built-in recipes by their registry id", () => {
    expect(Object.keys(RECIPES).sort()).toEqual(["blocker_sweep", "retro", "standup"]);
    for (const [key, def] of Object.entries(RECIPES)) {
      // The map key IS the recipe id the dispatcher looks up.
      expect(def.id).toBe(key);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.icon.length).toBeGreaterThan(0);
      expect(def.configFields.length).toBeGreaterThan(0);
    }
  });

  it("every recipe yields a valid cybo: claude provider, slug, non-empty soul, real grants", () => {
    for (const def of Object.values(RECIPES)) {
      const plan = def.plan({});
      expect(plan.cybo.provider).toBe("claude");
      // Slug must match the cybo schema regex (lowercase alnum + interior dashes).
      expect(plan.cybo.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/);
      expect(plan.cybo.name.length).toBeGreaterThan(0);
      expect(plan.cybo.soul.length).toBeGreaterThan(0);
      // Soul stays within the cybo schema's 50k cap.
      expect(plan.cybo.soul.length).toBeLessThanOrEqual(50000);
      // Only REAL platform-permission grants (closed enum) — an invalid grant
      // would fail the cybo create schema at provisioning time.
      expect(plan.cybo.platformPermissions.length).toBeGreaterThan(0);
      for (const p of plan.cybo.platformPermissions) {
        expect(PERM_SET.has(p)).toBe(true);
      }
      // Both write grants every recipe cybo needs: post + manage tasks.
      expect(plan.cybo.platformPermissions).toContain("send_message");
      expect(plan.cybo.platformPermissions).toContain("create_task");
    }
  });

  it("every schedule a recipe yields carries a valid cron", () => {
    for (const def of Object.values(RECIPES)) {
      const plan = def.plan({});
      for (const s of plan.schedules) {
        expect(() =>
          validateScheduleCadence({
            type: "cron",
            expression: s.cron,
            timezone: s.timezone ?? undefined,
          }),
        ).not.toThrow();
        expect(s.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it("standup: a Standup cybo + 2 schedules (ask + summarize) bound to the standup channel", () => {
    const plan = RECIPES.standup.plan({ standupChannelId: "chan-standup" });
    expect(plan.cybo.name).toBe("Standup");
    expect(plan.cybo.slug).toBe("standup");
    expect(plan.schedules).toHaveLength(2);
    expect(plan.channelIds).toEqual(["chan-standup"]);
    // Both schedules target the standup channel config key.
    for (const s of plan.schedules) {
      expect(s.targetChannelKey).toBe("standupChannelId");
    }
    // Defaults: weekday 9am ask, 10am summarize.
    expect(plan.schedules[0].cron).toBe("0 9 * * 1-5");
    expect(plan.schedules[1].cron).toBe("0 10 * * 1-5");
  });

  it("retro: a Retro cybo + 2 schedules (collect + summarize) bound to the retro channel", () => {
    const plan = RECIPES.retro.plan({ retroChannelId: "chan-retro" });
    expect(plan.cybo.name).toBe("Retro");
    expect(plan.cybo.slug).toBe("retro");
    expect(plan.schedules).toHaveLength(2);
    expect(plan.channelIds).toEqual(["chan-retro"]);
    // Defaults: Friday 2pm collect, 4pm summarize.
    expect(plan.schedules[0].cron).toBe("0 14 * * 5");
    expect(plan.schedules[1].cron).toBe("0 16 * * 5");
  });

  it("blocker_sweep: a Blocker Sweep cybo + 1 schedule bound to the escalation channel", () => {
    const plan = RECIPES.blocker_sweep.plan({
      escalationChannelId: "chan-esc",
      stalenessDays: 2,
    });
    expect(plan.cybo.name).toBe("Blocker Sweep");
    expect(plan.cybo.slug).toBe("blocker-sweep");
    expect(plan.schedules).toHaveLength(1);
    expect(plan.channelIds).toEqual(["chan-esc"]);
    expect(plan.schedules[0].targetChannelKey).toBe("escalationChannelId");
    // Default: weekday twice-daily sweep.
    expect(plan.schedules[0].cron).toBe("0 10,16 * * 1-5");
    // The sweep scans the whole workspace; the staleness window flows into the
    // soul so the cybo knows what counts as stale.
    expect(plan.cybo.soul).toContain("across the workspace");
  });

  it("honors config overrides for crons and timezone", () => {
    const plan = RECIPES.standup.plan({
      standupChannelId: "c1",
      sendCron: "30 8 * * 1-5",
      summarizeCron: "0 11 * * 1-5",
      timezone: "America/New_York",
    });
    expect(plan.schedules[0].cron).toBe("30 8 * * 1-5");
    expect(plan.schedules[1].cron).toBe("0 11 * * 1-5");
    expect(plan.schedules[0].timezone).toBe("America/New_York");
  });

  it("a recipe with no channel config yields no channel memberships (channelIds empty)", () => {
    const plan = RECIPES.standup.plan({});
    expect(plan.channelIds).toEqual([]);
    // The schedule still exists — it just runs without a bound channel until configured.
    expect(plan.schedules).toHaveLength(2);
  });
});
