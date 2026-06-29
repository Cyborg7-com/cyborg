# Design — autonomy-dials-schema (S2)

## Context

`internal docs` (the 7 axes, the `L0..L5` ladder, `min(cybo,channel)` placement) and
`internal docs` (THE FEATURE, the per-level budget table, the resolved open questions)
specify a two-dial autonomy model. S1 extracts the pure `shouldInvoke` gate; **S2 (this
change) supplies the two dials it reads + the `min()` resolver**, plumbed through every
storage/transport layer exactly as `tool_grants` and `behavior_mode` already are.

The proven reference is the Composio `tool_grants` round-trip
(`composio-tool-grants-roundtrip.test.ts`): a value created via the WS handlers survives
`DualStorage.createCybo → SQLite → getCybo → updateCybo (set/clear/preserve)` and reads
back identically. S2 mirrors that pattern shape-for-shape.

## Key decisions

### D1 — Store the level as a TEXT enum (`"L0".."L5"`), compare by rank.
Consistent with the existing TEXT enums on the row (`llm_auth_mode`, `behavior_mode`) and
human-readable in the DB. The resolver maps level → numeric rank (`AUTONOMY_RANK`) so
`min()` is numeric, **never a string comparison** (the one ordering bug to avoid). Presets
are names over levels, not a separate column.

### D2 — `autonomy_level` is additive + nullable; `behavior_mode` stays (deprecated).
Renaming a persisted column/value is breaking (`cybo-types.ts` header rule). So we ADD
`autonomy_level`, **backfill** from `behavior_mode` in the migration (`responsive→L1`,
`proactive→L3`), and leave `behavior_mode` on the row, read-only, until S3 removes it once
no client sends it. NULL `autonomy_level` (an un-migrated row, or an old daemon's write)
resolves via `behaviorModeToLevel(behavior_mode)` → so old + new daemons agree during the
transition (the `0023_workspace_agent_autonomy` nullable-tolerance pattern).

### D3 — The resolver is a pure module (`autonomy-dials.ts`), importable by daemon AND relay.
Same constraint as `chain-router.ts`: zero I/O, no daemon deps, so the relay-light bundle
can import it. S1's gate calls `resolveEffectiveAutonomy()`; S2 ships + unit-tests it but
does NOT wire it into any wake path (that is S1's job — keeps S2 behavior-neutral).

### D4 — Behavior-neutral defaults so the schema-only change is a no-op at runtime.
- cybo `autonomy_level` NULL → `behaviorModeToLevel(behavior_mode)` (default `L1`).
- channel `regime` NULL → `open`; channel `max_autonomy_level` NULL → `L4` (highest
  non-experimental; `L5`/swarm is a regime + flag, never a per-cybo preset — `internal docs`
  resolved-question 1). These keep every existing channel/cybo at today's effective agency
  until an admin sets a dial AND S1 consumes it.

### D5 — Per-channel dials reuse the existing `cyborg:update_channel` write path.
`channels.auto_tasks_enabled` is the precedent: a per-channel interaction-regime flag set
through `cyborg:update_channel` (relay `:5080`, pg `updateChannel`, `mapChannel`). We add
`regime` + `max_autonomy_level` to that same message + setter rather than inventing a new
message type — minimal surface, same auth (creator / ws-admin / channel-admin).

### D6 — `pg-sync` write-when-present, so an un-migrated PG tolerates a create.
`createCybo` only includes `autonomyLevel` in the insert when non-null (the `toolGrants`
guard at `pg-sync.ts:3337`). With the migration not yet applied, a normal cybo create
(no autonomy set) is byte-identical and never references the new column. Same rationale
forbids hand-applying the migration to the shared prod RDS — it runs only via the
programmatic migrator (root `CLAUDE.md` relay-deploy rule).

## Layer map (mirrors `tool_grants` / `behavior_mode`)

| Layer | File | What S2 adds |
|---|---|---|
| Row type | `cybo-types.ts` | `StoredCybo.autonomy_level`; `AUTONOMY_LEVELS`/rank/presets/`CHANNEL_REGIMES`/`behaviorModeToLevel` |
| Resolver | `autonomy-dials.ts` (new) | pure `resolveEffectiveAutonomy()` (`min` by rank + defaults) |
| Drizzle | `db/schema.ts` | `cybos.autonomyLevel`, `channels.regime`, `channels.maxAutonomyLevel` |
| Migration | `db/drizzle/0030_autonomy_dials.sql` + `_journal.json` | additive `IF NOT EXISTS` + backfill |
| SQLite | `storage.ts` | columns, stmts, binders, `setChannelAutonomy` + getters |
| DualStorage | `dual-storage.ts` | opts thread-through + channel setter |
| pg-sync | `db/pg-sync.ts` | write-when-present + `mapCybo`/`mapChannel` + channel setter |
| WS schema | `cyborg-messages.ts` | `autonomyLevel` on create/update_cybo; `regime`/`maxAutonomyLevel` on update_channel |
| Dispatcher | `dispatcher.ts` | local create/update_cybo + channel handlers |
| Relay | `relay-standalone.ts` | cloud create/update_cybo + update_channel + pending-replay |

## Open questions (resolved per internal docs, recorded for S1/S3)

- **How many public presets?** 4 (`Off/Mention/Active/Autonomous`). `L5` swarm = channel
  regime + experimental flag, not a per-cybo preset. (S3 surfaces the presets; S2 stores
  the underlying `L0..L5`.)
- **Memory store / proactive runtime / anti-loop budgets** — NOT S2. Those land in S4–S6.

## Migration hazard (must flag in the PR)

1. **Numbering collision (parallel branches).** `0030` may be claimed by another in-flight
   branch. Convention (`MEMORY: migration-numbering`): renumber by merge order at merge
   time; re-stamp the journal `when` above the live DB max.
2. **Never hand-apply to shared prod RDS.** Additive + `IF NOT EXISTS`, applied only by the
   programmatic migrator (bootstrap / `relay-deploy.yml`).
