# autonomy-ux — Cybo Autonomy Phase 1 frontend (S3)

## Why

`internal docs` + `internal docs` define the "Cybo Autonomy" feature: **two dials → `min()`**.
Every cybo carries a **per-cybo autonomy level** (its disposition); every channel sets a
**regime** that acts as a **ceiling**; the cybo's *effective* agency in a channel is
`min(cybo.level, channel.ceiling)`. Today neither dial is surfaced anywhere in the UI — the
only related control is the inert `behavior_mode` string shown read-only on the cybo Overview.

The backend wiring for these dials is delivered by **S2 (the WS schema + server handlers)**.
**S3 is the frontend that consumes S2**: it gives operators the two controls and — critically —
**surfaces the effective (capped) level wherever a cybo appears in a channel**, so the `min()`
is never a surprise. Without this, S2's behaviour change ("a chatty cybo goes silent in a
mention-only channel") would land with no way to see or set it.

This change is **Phase 1 frontend only**. It introduces **no new tab** and invents no feature
that isn't in `internal docs` (Phase 1: "the per-cybo Autonomy control + the per-channel
regime setting"). It reuses the existing channel AI panel and the existing cybo Overview tab.

## What Changes

1. **Channel regime → a new "Agents" section inside `ChannelAiPanel.svelte`** (which already hosts
   the slash-model override + auto-tasks-adjacent config). A 3-way selector:
   **Mention-only · Open · Agent channel (Swarm)**. Choosing **Agent channel** opens a
   **confirm dialog** (it is expensive + experimental) before it persists; it sets the channel
   ceiling (`max_autonomy_level`) + regime. No new dialog tab — it lives in the existing **AI** tab
   of `ChannelDetailsDialog`.

2. **Per-cybo level → an "Autonomy" section on the cybo detail _Overview_** (`cybo/[cyboId]/+page.svelte`,
   `TabsContent value="overview"`) — **NOT a new tab** (the `TABS` array stays 5). Four presets:
   **Off · Mention-only · Active · Autonomous**, plus an **"Advanced" disclosure** that exposes the
   7 axes (`internal docs`) for power users. The preset is the single dial; the disclosure is the
   power-user override.

3. **Effective-level surfacing.** Wherever a cybo is shown in a **channel context** (the channel
   details **Members** list cybo rows, and the new Agents section header), render
   **"Effective here: X (capped by channel)"** when `min()` differs from the cybo's own level —
   computed client-side from the two persisted values.

4. **UI wiring (in `packages/ui` only).** Thin `client.ts` request wrappers + `app.svelte.js`
   apply-mutators + optional fields on the client `Channel`/`Cybo` types that mirror S2's wire
   shape. **No wire-protocol or server code** — that is S2's surface.

## Impact

- **Package boundary:** `packages/ui/` ONLY.
- **Affected files (new/edited):**
  - `packages/ui/src/lib/components/channel/ChannelAiPanel.svelte` (add Agents/regime section)
  - new `packages/ui/src/lib/components/channel/ChannelAgentsRegime.svelte` (the 3-way selector + confirm)
  - `packages/ui/src/routes/workspace/[id]/cybo/[cyboId]/+page.svelte` (Autonomy section on Overview)
  - new `packages/ui/src/lib/components/cybo/CyboAutonomyControl.svelte` (presets + Advanced disclosure)
  - new `packages/ui/src/lib/components/channel/EffectiveLevelBadge.svelte` (the `min()` surfacing)
  - `packages/ui/src/lib/components/channel/ChannelDetailsDialog.svelte` (badge in cybo member rows)
  - `packages/ui/src/lib/core/client.ts` + `packages/ui/src/lib/state/app.svelte.js` (request wrappers + mutators)
  - `packages/ui/src/lib/core/types.ts` + `packages/ui/src/lib/plugins/agents/types.ts` (optional client fields mirroring S2)
  - new `packages/ui/e2e/cybo-autonomy-ux.spec.ts` (Playwright, worker-scoped test-daemon fixture)
- **Depends on:** S2 (autonomy WS schema + server handlers + persistence). S3 is **inert** until
  S2's handlers exist; the controls degrade to read-the-default when S2 fields are absent.
- **No new tabs, no `behavior_mode` removal** (S2 owns the field migration); the Overview's existing
  read-only "Behavior mode" row is superseded visually by the new Autonomy section but not deleted here.
