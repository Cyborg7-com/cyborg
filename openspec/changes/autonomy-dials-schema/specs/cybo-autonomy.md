# Capability: cybo-autonomy (delta — S2: dials + resolver)

## ADDED Requirements

### Requirement: Per-cybo autonomy level
A cybo SHALL carry a persisted `autonomy_level` in `{ L0, L1, L2, L3, L4, L5 }`
representing its interaction-agency disposition, replacing the inert `behavior_mode`.

#### Scenario: Create persists the level
- WHEN a `cyborg:create_cybo` includes `autonomyLevel: "L4"`
- THEN the stored cybo's `autonomy_level` reads back `"L4"` from SQLite and (when connected) PG.

#### Scenario: Update replaces, unrelated update preserves
- WHEN `cyborg:update_cybo` sets `autonomyLevel: "L2"`, THEN it reads back `"L2"`.
- WHEN a later `update_cybo` changes only `name`, THEN `autonomy_level` stays `"L2"`.

#### Scenario: Backfill from behavior_mode
- WHEN a pre-existing cybo has `behavior_mode = "proactive"` and no `autonomy_level`
- THEN the migration backfills `autonomy_level = "L3"` (`responsive → L1`), preserving disposition.

#### Scenario: Old client without autonomyLevel
- WHEN a create omits `autonomyLevel` but sends `behaviorMode: "responsive"`
- THEN the resolved level defaults to `L1` (no behavior change for old clients).

### Requirement: Per-channel regime and ceiling
A channel SHALL carry a persisted `regime` in `{ mention-only, open, swarm }` and a
`max_autonomy_level` ceiling in `{ L0..L5 }`, both nullable with behavior-neutral defaults
(`regime → open`, `max_autonomy_level → L4`).

#### Scenario: Settings round-trip
- WHEN `cyborg:update_channel` sets `regime: "mention-only"`, `maxAutonomyLevel: "L1"`
- THEN both read back via the channel getters and survive the SQLite + PG round-trip.

### Requirement: Effective-autonomy resolver (`min`)
A pure `resolveEffectiveAutonomy({ cyboLevel, channelRegime, channelMaxLevel })` SHALL
return `effectiveLevel = min(cyboLevel, channelMaxLevel)` compared by numeric rank, with the
regime carried through. The venue ceiling always wins.

#### Scenario: Venue caps a chatty cybo
- WHEN an `L4` cybo is resolved against a `mention-only`/`L1` channel
- THEN `effectiveLevel = L1`.

#### Scenario: Lurker keeps its low disposition in a swarm
- WHEN an `L2` cybo is resolved against a `swarm`/`L4` channel
- THEN `effectiveLevel = L2`.

#### Scenario: Null defaults
- WHEN `channelMaxLevel` is null and `regime` is null
- THEN they default to `L4`/`open` and the cybo's own level (or `L1`) is the floor.

## Notes
- This delta covers **data + resolver only**. Consumption by the invocation gate is S1.
- `behavior_mode` is retained (deprecated, read-only) until S3.
