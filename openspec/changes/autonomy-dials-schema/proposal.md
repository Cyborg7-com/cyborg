# autonomy-dials-schema — Phase 1 backend: the two dials + the `min()` resolver

Status: proposed
Owner: cyborg/autonomy
Package: `packages/server/src/server/cyborg/` ONLY
Workstream: **S2** of the Cybo Autonomy feature. Depends on **S1** (invocation gate). Blocks **S3–S6** (UI, proactive, social, swarm).

## Why

`internal docs` + `internal docs` ("THE FEATURE — Cybo Autonomy") define the user-facing
config as exactly **two dials**:

- A **per-cybo autonomy level** (`L0..L5`, surfaced as 4 public presets) — the cybo's
  disposition; travels with it across channels.
- A **per-channel regime** (`mention-only | open | swarm`) plus a **`max_autonomy_level`
  ceiling** — the venue's social contract.

The effective agency of a cybo in a channel is the **floor of the two**:
`effectiveLevel = min(cybo.autonomyLevel, channel.maxAutonomyLevel)` (clamped further by
the regime). Today neither dial exists. The only adjacent field is the **inert
`behavior_mode`** (`responsive` | `proactive`) on `cybos`, which is wired through every
storage layer but changes nothing at runtime (`internal docs`).

This change lands the **data + resolver** for both dials so the S1 invocation gate has
something to read. It is the smallest behavior-safe slice: it persists the dials and
exposes a pure `resolveEffectiveAutonomy()`; it does **not** itself change when a cybo
wakes (that is S1 consuming the resolver). Phase 1 from the knowledge plan.

## What changes

1. **Replace the inert `behavior_mode` with `autonomy_level` (`L0..L5`).** Additive new
   column; the migration **backfills** existing rows (`responsive → L1`, `proactive → L3`)
   so no cybo changes disposition. `behavior_mode` stays on the row (read-only, deprecated)
   until S3 drops it — never renamed (renaming a persisted column is breaking;
   `cybo-types.ts` header rule). The WS layer keeps **accepting** `behaviorMode` for one
   release (old clients) and maps it onto `autonomyLevel` when `autonomyLevel` is absent.

2. **Per-channel `regime` + `max_autonomy_level`.** Two additive columns on `channels`,
   mirroring the `auto_tasks_enabled` per-channel-regime precedent. Nullable so existing
   rows stay byte-identical; the resolver supplies behavior-neutral defaults
   (`regime` NULL → `open`, `max_autonomy_level` NULL → `L4`).

3. **The `min()` resolver** — one pure module (`autonomy-dials.ts`, zero I/O, importable
   by daemon AND the relay-light bundle, in the style of `chain-router.ts`):
   `resolveEffectiveAutonomy({ cyboLevel, channelRegime, channelMaxLevel })
     → { effectiveLevel, regime }`. Level ordering via a rank map (`L0=0 … L5=5`);
   `min()` operates on the rank. S1's gate calls this; this change ships it + unit-tests it.

4. **Full round-trip through every existing layer** (mirrors the proven
   `tool_grants` / `behavior_mode` plumbing — see `composio-tool-grants-roundtrip.test.ts`):
   - SQLite `storage.ts`: `cybos.autonomy_level` column (CREATE TABLE + `addColumnIfMissing`)
     in the insert/update/get stmts + binders; `StoredCybo.autonomy_level`
     (`cybo-types.ts`); `channels.regime` + `channels.max_autonomy_level` columns + a
     `setChannelAutonomy(channelId, { regime, maxLevel })` setter + getter.
   - `dual-storage.ts`: thread `autonomyLevel` through `createCybo`/`updateCybo` opts;
     add the channel-autonomy setter (SQLite-first, fire-and-forget PG).
   - `db/schema.ts`: drizzle columns `cybos.autonomyLevel`, `channels.regime`,
     `channels.maxAutonomyLevel`.
   - `db/pg-sync.ts`: **write-when-present** for `autonomyLevel` (same guard as
     `toolGrants` at `:3337` so a create never references the column before the migration
     applies) + `updateCybo` set-branch + `mapCybo` read; channel update + `mapChannel`.
   - `cyborg-messages.ts`: `autonomyLevel` on `create_cybo` / `update_cybo` (nullable on
     update to clear→default); channel `regime` + `maxAutonomyLevel` on a channel-settings
     message (extend `cyborg:update_channel`, the existing per-channel-settings write path).
   - `dispatcher.ts`: local-daemon `create_cybo` / `update_cybo` handlers pass
     `autonomyLevel`; channel-settings handler writes regime/maxLevel.
   - `relay-standalone.ts`: cloud `create_cybo` / `update_cybo` + `update_channel` handlers
     (the `inner.*` extraction sites: `:1112`, `:4876`, `:4987`, `:5103`) including the
     pending-replay path.

5. **Versioned drizzle migration** `0030_autonomy_dials.sql` (+ `_journal.json` entry):
   additive, idempotent (`ADD COLUMN IF NOT EXISTS`), `when` stamped above the live DB max,
   plus the `behavior_mode → autonomy_level` backfill `UPDATE`.

## Out of scope (explicitly)

- The invocation gate / `shouldInvoke` (S1) — this change only supplies the data + resolver
  it reads. No wake-path behavior changes here.
- UI for the dials (S3).
- Proactive/social/swarm runtime (S4–S6), the anti-loop budgets, memory tables.
- Dropping the `behavior_mode` column (deferred to S3 once no client sends it).

## Impact

- **Affected specs:** `cybo-autonomy` (new capability — the two dials + resolver).
- **Affected code:** `packages/server/src/server/cyborg/` only:
  `cybo-types.ts`, `autonomy-dials.ts` (new), `storage.ts`, `dual-storage.ts`,
  `db/schema.ts`, `db/pg-sync.ts`, `db/drizzle/0030_autonomy_dials.sql` (new) + journal,
  `cyborg-messages.ts`, `dispatcher.ts`, `relay-standalone.ts`.
- **Behavior:** none at runtime until S1 consumes the resolver. Pure additive schema +
  a pure function + a backfill that preserves every cybo's disposition.

## Risks

- **Migration-numbering collision (parallel branches).** `0029_composio_tools` is the
  highest tag on this branch; other in-flight branches may also claim `0030`. Convention
  (`MEMORY: migration-numbering`): renumber by **merge order** at merge time; if `0030` is
  taken when this merges, bump to the next free index and re-stamp the journal `when` above
  the live DB max. Flag in the PR.
- **Never apply to the shared prod RDS by hand.** Per root `CLAUDE.md` (relay-deploy) the
  migration is additive + `IF NOT EXISTS` and runs only via the programmatic migrator
  (bootstrap / `relay-deploy.yml`). The `pg-sync` write-when-present guard means an
  un-migrated DB tolerates a cybo create. Do **not** `psql` it onto prod.
- **`min()` ordering bug** if levels are compared as strings — the resolver MUST map to a
  numeric rank. Covered by unit tests.
