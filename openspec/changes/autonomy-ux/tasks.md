# Tasks — autonomy-ux (S3)

Ordered so each task is independently loop-resolvable (compiles + passes its own check) and the
next builds on the previous. Every UI task ends with the Playwright e2e that proves it round-trips.

> Boundary check before every task: edits stay inside `packages/ui/`. If a change needs a wire type
> or server handler, it belongs to **S2** — stub against the S2 method name and stop.

## 1. Client wiring + types (consume S2, define nothing on the wire)

- [ ] 1.1 Add optional client fields mirroring S2's round-tripped shape:
  - `packages/ui/src/lib/core/types.ts` → `Channel`: `regime?: "mention-only" | "open" | "swarm"`,
    `maxAutonomyLevel?: number | null`.
  - `packages/ui/src/lib/plugins/agents/types.ts` → `Cybo`: `autonomyLevel?: number | null`
    (the preset's level) and `autonomyAxes?: Record<string, number | string> | null` (the 7-axis override).
- [ ] 1.2 Add `client.ts` request wrappers calling the **S2** message types (same pattern as
  `setChannelSlashCommandModel`): `setChannelRegime(workspaceId, channelId, regime, maxAutonomyLevel)`
  → `cyborg:set_channel_regime`; `setCyboAutonomy(cyboId, level, axes?)` → `cyborg:set_cybo_autonomy`.
- [ ] 1.3 Add `app.svelte.js` apply-mutators (`applyChannelRegime`, `applyCyboAutonomy`) that fold the
  server's authoritative response back into `channelState`/`cyboState` so reopening a panel reflects it
  (mirrors `applyChannelSlashModel`).
- [ ] 1.4 Verify: `pnpm -C packages/ui exec tsc --noEmit` (or `pnpm -C packages/ui lint`) is clean.

## 2. Channel regime selector (the 3-way control)

- [ ] 2.1 New `ChannelAgentsRegime.svelte` (`components/channel/`): a 3-way segmented selector
  (shadcn-svelte `ToggleGroup`/`Tabs`, theme tokens only) — **Mention-only · Open · Agent channel (Swarm)**.
  Seed from `channel.regime` (default `mention-only`); `disabled` while a write is in flight; admin-gated
  by the caller. Picking Mention-only / Open persists immediately via `setChannelRegime`.
- [ ] 2.2 Mount it as a new **"Agents"** `<section>` inside `ChannelAiPanel.svelte`, above/below the
  existing slash-model sections, using the same `sectionHeader` class and copy explaining the ceiling.
- [ ] 2.3 e2e (regime persist): `cybo-autonomy-ux.spec.ts` → set a channel to **Open**, reload, assert the
  selector reseeds to Open (round-trips through S2).

## 3. Confirm dialog for "Agent channel (Swarm)"

- [ ] 3.1 Selecting **Agent channel** does NOT persist directly — it opens a `ConfirmDialog`
  (reuse `components/ConfirmDialog.svelte`) warning it's **expensive + experimental** and lifts the
  agent→agent firewall in this channel. Confirm → `setChannelRegime(..., "swarm", L5ceiling)`; cancel →
  revert the selector to the prior value.
- [ ] 3.2 e2e (swarm confirm + persist): click **Agent channel** → assert confirm appears → confirm →
  reload → assert selector shows **Agent channel** and the section shows the swarm caption.

## 4. Per-cybo autonomy control (4 presets)

- [ ] 4.1 New `CyboAutonomyControl.svelte` (`components/cybo/`): 4 preset buttons —
  **Off · Mention-only · Active · Autonomous** (radio semantics, theme tokens). Seed from
  `cybo.autonomyLevel` (fallback: map the legacy `behaviorMode` → `responsive→Mention-only`,
  `proactive→Active`). Picking a preset persists via `setCyboAutonomy(cyboId, level)`.
- [ ] 4.2 Mount as a new **"Autonomy"** section card on the cybo **Overview** tab in
  `cybo/[cyboId]/+page.svelte` (reuse the `sectionHeader` snippet) — **do not add a tab**; keep `TABS` at 5.
- [ ] 4.3 e2e (cybo preset persist): open a cybo Overview → pick **Active** → reload → assert the
  **Active** preset is selected.

## 5. Advanced disclosure (the 7 axes)

- [ ] 5.1 Inside `CyboAutonomyControl.svelte`, add an **"Advanced"** disclosure (shadcn-svelte
  `Collapsible`, collapsed by default) exposing the 7 axes from `internal docs`
  (trigger/initiative, goal-source, social-scope, action-scope, oversight, continuity, capability) as
  individual controls. Editing an axis persists `axes` via `setCyboAutonomy(cyboId, level, axes)`;
  changing a preset resets the axes to the preset's defaults.
- [ ] 5.2 e2e (disclosure): assert Advanced is collapsed by default, expands on click, and the axis
  controls render (no need to persist each axis — one representative axis round-trip is enough).

## 6. Effective-level surfacing (the `min()` badge)

- [ ] 6.1 New `EffectiveLevelBadge.svelte` (`components/channel/`): props `cyboLevel`, `channelCeiling`;
  renders **"Effective here: <label>"** and, when `min(cyboLevel, ceiling) < cyboLevel`, appends
  **"(capped by channel)"** with a tooltip. Pure/derived — no I/O.
- [ ] 6.2 Render it in `ChannelDetailsDialog.svelte` cybo member rows (Members tab) and in the
  `ChannelAgentsRegime` section header for the current channel context.
- [ ] 6.3 e2e (effective min): with a cybo at **Autonomous** in a **Mention-only** channel, assert the
  badge reads the mention-only label + "(capped by channel)"; raise the channel to **Open** and assert
  the badge updates to the min of the two.

## 7. Wiring, a11y, and full-suite green

- [ ] 7.1 Admin-gate the writable controls (regime + cybo level) the same way `ChannelAiPanel` is gated
  (`isChannelAdmin`); non-admins see the values read-only with the effective badge.
- [ ] 7.2 Keyboard + ARIA: selectors are roving-tabindex radio/segmented groups; confirm dialog traps
  focus (ConfirmDialog already does). Theme tokens only — no hardcoded colors/sizes.
- [ ] 7.3 Run the full e2e file and the existing suite; assert no regressions.

## CLI-first verification (exact invocations)

```bash
# the single new spec (all S3 assertions live here):
cd packages/ui && npx playwright test e2e/cybo-autonomy-ux.spec.ts

# a single assertion while iterating (Playwright -g title grep):
cd packages/ui && npx playwright test e2e/cybo-autonomy-ux.spec.ts -g "channel regime persists"
cd packages/ui && npx playwright test e2e/cybo-autonomy-ux.spec.ts -g "agent channel requires confirm"
cd packages/ui && npx playwright test e2e/cybo-autonomy-ux.spec.ts -g "cybo level preset persists"
cd packages/ui && npx playwright test e2e/cybo-autonomy-ux.spec.ts -g "effective level shows the min"

# regression gate (no other UI e2e broke):
cd packages/ui && npx playwright test
```
