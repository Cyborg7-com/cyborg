# Tasks — autonomy-dials-schema (S2)

One layer per task, dependency-ordered (bottom-up: pure types → schema → migration →
SQLite → DualStorage → pg-sync → WS messages → dispatcher → relay → round-trip test).
Each task is independently loop-resolvable and has an exact `npx vitest run …` command
(run from `packages/server/`). NO manual testing. "Today's behavior preserved" is the
contract for every task (additive only).

---

- [ ] **1. Pure level/regime constants + the `min()` resolver.**
  - `cybo-types.ts`: add `AUTONOMY_LEVELS = ["L0","L1","L2","L3","L4","L5"] as const`,
    `type AutonomyLevel`, an `AUTONOMY_RANK: Record<AutonomyLevel, 0..5>` map, the 4 public
    presets (`Off=L0`, `Mention=L1`, `Active=L3`, `Autonomous=L4`), `CHANNEL_REGIMES =
    ["mention-only","open","swarm"] as const`, `type ChannelRegime`, and
    `behaviorModeToLevel(mode): AutonomyLevel` (`responsive→L1`, `proactive→L3`). Keep
    `BEHAVIOR_MODES` (deprecated, do not delete).
  - New pure module `autonomy-dials.ts` (zero I/O, like `chain-router.ts`):
    `resolveEffectiveAutonomy({ cyboLevel, channelRegime, channelMaxLevel })
      → { effectiveLevel: AutonomyLevel; regime: ChannelRegime }` =
    rank-`min(cyboLevel, channelMaxLevel)`; NULL cyboLevel → fall back via the cybo's
    `behavior_mode` mapping or `L1`; NULL `channelMaxLevel` → `L4`; NULL regime → `open`.
  - Tests `autonomy-dials.test.ts`: `min()` matrix (chatty `L4` cybo in `mention-only`/`L1`
    channel → `L1`; lurker `L2` in swarm/`L4` → `L2`; equal; NULL defaults both sides);
    preset round-trip; `behaviorModeToLevel` mapping.
  - **Verify:** `npx vitest run src/server/cyborg/autonomy-dials.test.ts --reporter=verbose`

- [ ] **2. Drizzle schema columns.**
  - `db/schema.ts`: `cybos.autonomyLevel = text("autonomy_level")` (nullable, additive,
    placed next to `behaviorMode` with a deprecation comment on `behaviorMode`);
    `channels.regime = text("regime")` and `channels.maxAutonomyLevel =
    text("max_autonomy_level")` (both nullable, next to `autoTasksEnabled`).
  - **Verify (typecheck is the gate for a schema-only edit):** `npm run typecheck`

- [ ] **3. Versioned migration + journal.**
  - `db/drizzle/0030_autonomy_dials.sql`: `ALTER TABLE "cybos" ADD COLUMN IF NOT EXISTS
    "autonomy_level" text;` · `ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "regime"
    text;` · `ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "max_autonomy_level" text;` ·
    backfill `UPDATE "cybos" SET "autonomy_level" = CASE "behavior_mode" WHEN 'proactive'
    THEN 'L3' ELSE 'L1' END WHERE "autonomy_level" IS NULL;`. Header copied from
    `0029_composio_tools.sql` (additive + idempotent + hand-applied-prod convention).
  - Append the `0030` entry to `db/drizzle/meta/_journal.json` with `when` ABOVE
    `0029`'s (`1783000005000`), e.g. `1783000006000` (so the migrator never skips it).
  - Test `autonomy-migration.test.ts`: build a fresh in-memory/temp PG (or the existing
    migrate-test harness — see `storage-migrate.test.ts`/`db/migrate.test.ts` pattern),
    run the migrator twice (idempotency), assert the three columns exist and a
    `behavior_mode='proactive'` row backfills to `autonomy_level='L3'`, `responsive`→`L1`.
  - **Verify:** `npx vitest run src/server/cyborg/autonomy-migration.test.ts --reporter=verbose`
  - **Note in PR:** numbering-collision hazard (parallel branches) + "additive, never hand-apply to prod RDS".

- [ ] **4. SQLite storage layer (`storage.ts` + `cybo-types.ts` row type).**
  - `cybo-types.ts` `StoredCybo`: add `autonomy_level: string | null`.
  - `storage.ts`: add `autonomy_level TEXT` to the `cybos` CREATE TABLE +
    `addColumnIfMissing("cybos","autonomy_level","TEXT")`; add `regime TEXT` +
    `max_autonomy_level TEXT` to `channels` CREATE TABLE + `addColumnIfMissing`. Extend
    `insertCyboStmt`/`updateCyboStmt` column lists + the binders in
    `createCybo`/`persistCybo`/`updateCybo` (mirror `tool_grants`: store the string;
    `updates.autonomyLevel !== undefined ? … : existing.autonomy_level`). Add
    `setChannelAutonomy(channelId, { regime?, maxLevel? })` (UPDATE) + getters
    `getChannelRegime` / `getChannelMaxAutonomyLevel` (mirror `getChannelAutoTasksEnabled`).
  - Extend the existing `dual-storage`/round-trip tests OR add SQLite-level assertions in
    task 10's round-trip; minimum here: the column survives create→get.
  - **Verify:** `npx vitest run src/server/cyborg/storage-migrate.test.ts --reporter=verbose`

- [ ] **5. DualStorage opts (`dual-storage.ts`).**
  - Add `autonomyLevel?: string | null` to `createCybo`/`updateCybo` opts (passed straight
    to SQLite then fire-and-forget PG, like `toolGrants`). Add `setChannelAutonomy` (SQLite
    write + `this._pg?.setChannelAutonomy(...).catch(logSyncError)`).
  - **Verify:** `npx vitest run src/server/cyborg/dual-storage.test.ts --reporter=verbose`

- [ ] **6. pg-sync mapper + writers (`db/pg-sync.ts`).**
  - `createCybo`: **write-when-present** `...(opts.autonomyLevel != null ? { autonomyLevel:
    opts.autonomyLevel } : {})` (the `:3337` toolGrants guard — never reference the column
    pre-migration). `updateCybo`: `if (updates.autonomyLevel !== undefined) set.autonomyLevel
    = updates.autonomyLevel`. `mapCybo`: read `autonomy_level: row.autonomyLevel ?? null`.
    Add `setChannelAutonomy(channelId, …)` (drizzle update) + extend `mapChannel` to surface
    `regime` / `max_autonomy_level` + a `getChannelRegime`/`getChannelMaxAutonomyLevel` read.
  - **Verify:** `npx vitest run src/server/cyborg/dual-storage.test.ts --reporter=verbose`
    (DualStorage drives pg-sync; if a pg-only test harness exists, run that file too.)

- [ ] **7. WS message schemas (`cyborg-messages.ts`).**
  - Define `AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS)` and `ChannelRegimeSchema =
    z.enum(CHANNEL_REGIMES)`. Add `autonomyLevel: AutonomyLevelSchema.optional()` to
    `CyborgCreateCyboRequestSchema`; `autonomyLevel: AutonomyLevelSchema.nullable().optional()`
    to `CyborgUpdateCyboRequestSchema` (null→clear→default). Keep `behaviorMode` accepted
    (deprecated). Extend the channel-settings write (`cyborg:update_channel` — the existing
    per-channel settings message) with `regime: ChannelRegimeSchema.nullable().optional()`
    and `maxAutonomyLevel: AutonomyLevelSchema.nullable().optional()`; surface both on the
    response/`mapChannel` wire shape.
  - **Verify:** `npx vitest run src/server/cyborg/relay-protocol.test.ts --reporter=verbose`
    (schema parse/round-trip; add cases there or in task 10.)

- [ ] **8. Dispatcher handlers (local daemon transport) (`dispatcher.ts`).**
  - `create_cybo` handler (`:5262`): pass `autonomyLevel: parsed.autonomyLevel` (fall back to
    `behaviorModeToLevel(parsed.behaviorMode)` when absent). `update_cybo` (`:5650`):
    `if (parsed.autonomyLevel !== undefined) updates.autonomyLevel = parsed.autonomyLevel`.
    Channel-settings handler (`update_channel` local path): call `setChannelAutonomy`.
    Include `autonomyLevel` in the local cybo wire mappers (`:5324`, `:5376`, `:5448`).
  - **Verify:** `npx vitest run src/server/cyborg/cyborg-phase1.test.ts --reporter=verbose`
    (the cybo create/update dispatcher path; extend with an autonomy assertion.)

- [ ] **9. Relay handlers + pending-replay (`relay-standalone.ts`).**
  - `create_cybo` (`:4876`): `autonomyLevel: typeof inner.autonomyLevel === "string" ?
    inner.autonomyLevel : undefined`. `update_cybo` (`:4987`): `if (inner.autonomyLevel ===
    null) ucUpdates.autonomyLevel = null; else if (typeof inner.autonomyLevel === "string")
    ucUpdates.autonomyLevel = inner.autonomyLevel`. Pending-replay create path (`:1112`):
    thread `autonomyLevel`. `update_channel` (`:5103`): add `regime` + `maxAutonomyLevel`
    to `ucUpdates` + call `setChannelAutonomy`; include both in `mapChannel`/the cybo roster
    mappers (`:2201`).
  - **Verify:** `npx vitest run src/server/cyborg/relay-broadcast-scope.test.ts --reporter=verbose`
    (relay handler smoke; if a relay create/update-cybo test exists, run it too.)

- [ ] **10. End-to-end persistence round-trip test (the S2 acceptance gate).**
  - New `autonomy-dials-roundtrip.test.ts` modeled on `composio-tool-grants-roundtrip.test.ts`:
    `DualStorage(new CyborgStorage(tmpDb), null)`; create a cybo with `autonomyLevel: "L4"`
    → `getCybo` returns `"L4"`; `updateCybo({ autonomyLevel: "L2" })` → `"L2"`; an unrelated
    update (`{ name }`) **preserves** the level; `updateCybo({ autonomyLevel: null })` →
    falls back to the default (NULL row, resolver yields the behavior-mode/`L1` default);
    a create with no `autonomyLevel` but `behaviorMode:"proactive"` → backfilled `L3` (via
    `behaviorModeToLevel`). Channel leg: `setChannelAutonomy(ch,{ regime:"mention-only",
    maxLevel:"L1" })` → getters read back; `resolveEffectiveAutonomy` over the round-tripped
    pair returns `effectiveLevel: "L1"` for the `L4` cybo (the `min()` end-to-end).
  - **Verify:** `npx vitest run src/server/cyborg/autonomy-dials-roundtrip.test.ts --reporter=verbose`

---

### Full-suite gate (after all tasks)
- `npm run typecheck`
- `npx vitest run src/server/cyborg/autonomy-dials.test.ts src/server/cyborg/autonomy-dials-roundtrip.test.ts src/server/cyborg/autonomy-migration.test.ts --reporter=verbose`
