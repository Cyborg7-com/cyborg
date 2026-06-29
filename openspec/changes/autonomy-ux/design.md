# Design — autonomy-ux (S3)

## Context

- Feature spec: `internal docs` (the 7 axes, the L0–L5 ladder, `min(cybo,channel)`)
  and `internal docs` ("THE FEATURE" exec summary, the 4 public presets).
- S3 is the **Phase 1 frontend**. The backend (the WS message schema, server handlers, PG columns) is
  **S2**. S3 must not define wire types — it calls S2's message names and folds the response into state.
- The design reuses the existing surfaces verbatim to avoid inventing UI (`CLAUDE.md`: "No features that
  don't exist in original", "shadcn-svelte first", "theme tokens, not hardcoded values",
  "components foldered by feature").

## The two dials and the floor (what the UI encodes)

| Dial | Where | Control | Values |
|---|---|---|---|
| Per-cybo **autonomy level** | cybo Overview (no new tab) | 4 presets + Advanced disclosure | Off (L0) · Mention-only (L1) · Active (L2–L3) · Autonomous (L4) |
| Per-channel **regime** (ceiling) | `ChannelAiPanel` → Agents section | 3-way selector + confirm for Swarm | Mention-only (≤L1) · Open (≤L3) · Agent channel/Swarm (≤L5) |

**Effective level = `min(cyboLevel, channelCeiling)`** — computed client-side and surfaced as a badge.
The regime maps to a numeric ceiling so `min()` is well-defined; the cybo preset maps to a level. The UI
never re-derives policy — it shows the floor of the two persisted numbers (S2 enforces it server-side).

## Decisions

1. **No new tab — extend existing surfaces.** The channel regime lives in the existing **AI** tab's
   `ChannelAiPanel` (a new "Agents" `<section>`, sibling to the slash-model sections). The cybo level
   lives in the existing **Overview** tab (a new "Autonomy" section card). This honors the explicit task
   constraint and the repo rule against inventing tabs. The `TABS` array in the cybo page stays at 5.

2. **Presets are the dial; axes are the override.** The 4 presets are the only thing most users touch;
   the 7 axes (`internal docs`) sit behind an "Advanced" `Collapsible`, collapsed by default. Picking a
   preset resets axes to that preset's defaults; editing an axis is a power-user override that still
   round-trips through the same `setCyboAutonomy` call (`level` + optional `axes`).

3. **Swarm is gated by a confirm dialog.** "Agent channel (Swarm)" is the expensive/experimental regime
   that lifts the agent→agent firewall (`internal docs`). Selecting it opens `ConfirmDialog` and only
   persists on confirm; cancel reverts the selector. This mirrors the destructive-action confirm pattern
   already used in `ChannelDetailsDialog` (remove member / leave) and `ChannelSettingsForm` (archive/delete).

4. **Effective-min is surfaced, never inferred silently.** A dedicated `EffectiveLevelBadge` renders
   "Effective here: X" and appends "(capped by channel)" when the channel ceiling lowers the cybo's own
   level. It appears in the channel Members list (cybo rows) and the Agents-section header — the two
   places a cybo is shown in a channel context. This is the whole point of S3: the `min()` is visible.

5. **Degrade gracefully when S2 is absent.** All new client fields are optional. If S2 hasn't shipped
   (fields undefined), the regime selector seeds to `mention-only`, the cybo control falls back to mapping
   the legacy `behaviorMode` (`responsive→Mention-only`, `proactive→Active`), and writes are best-effort
   (the apply-mutator only updates state on a successful response). No crash, no fabricated state.

6. **Admin-gating matches the host surface.** The regime selector is admin-only (same `isChannelAdmin`
   gate that already hides the AI tab); the cybo level control follows the cybo-edit permission. Non-admins
   see values read-only plus the effective badge.

## WS interaction (consuming S2 — not defining it)

Same shape as the existing `setChannelSlashCommandModel` round-trip:

```ts
// client.ts — wrappers over S2 message types (S2 owns the server handler + persistence)
client.setChannelRegime(workspaceId, channelId, regime, maxAutonomyLevel)  // → "cyborg:set_channel_regime"
client.setCyboAutonomy(cyboId, level, axes?)                               // → "cyborg:set_cybo_autonomy"
// app.svelte.js — fold the authoritative response back into state
applyChannelRegime(channelId, { regime, maxAutonomyLevel })
applyCyboAutonomy(cyboId, { level, axes })
```

The UI computes `min()` locally for the badge; the server is authoritative for enforcement.

## CLI-first test strategy (Playwright, worker-scoped test daemon)

`packages/ui/e2e/cybo-autonomy-ux.spec.ts` uses `./helpers/fixtures.ts` (`loginAs` + the worker-scoped
real `daemon` fixture, same as `channel-slash-menu.spec.ts`). Round-trip = set via the UI control, reload
the page, assert the control reseeds — proving persistence through the real daemon/S2 path. Test titles
(grep-able with `-g`):

- **"channel regime persists"** — open a channel's AI tab → Agents section → pick **Open** → reload →
  selector reseeds to **Open**.
- **"agent channel requires confirm and persists"** — pick **Agent channel** → assert `ConfirmDialog`
  visible → cancel reverts; pick again → confirm → reload → selector shows **Agent channel**.
- **"cybo level preset persists"** — cybo Overview → Autonomy section → pick **Active** → reload →
  **Active** is selected; assert Advanced disclosure is collapsed by default and expands on click.
- **"effective level shows the min"** — cybo at **Autonomous** in a **Mention-only** channel → badge reads
  the mention-only label + "(capped by channel)"; raise channel to **Open** → badge updates to the min.

Exact invocations are listed in `tasks.md` (CLI-first verification). No manual QA — every acceptance
criterion is a Playwright assertion.

## Out of scope (owned elsewhere)

- The wire schema, server handlers, PG columns, and `min()` **enforcement** → **S2**.
- The invocation gate (`shouldInvoke`), anti-loop, social/swarm runtime → P0/P3/P4 (`internal docs`).
- `behavior_mode` → `autonomy_level` field migration → S2 (S3 only reads it as a fallback seed).
- Scheduling/cron — a separate axis (`internal docs` intro), not touched here.
