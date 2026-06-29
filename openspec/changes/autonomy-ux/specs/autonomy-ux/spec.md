# autonomy-ux (delta)

Phase 1 frontend for Cybo Autonomy: the two dials and the effective-min surfacing, in `packages/ui`.

## ADDED Requirements

### Requirement: Per-channel autonomy regime control
The channel AI panel SHALL provide an admin-only 3-way regime selector — **Mention-only**, **Open**,
**Agent channel (Swarm)** — inside a new "Agents" section of `ChannelAiPanel`, no new tab. Selecting
**Mention-only** or **Open** SHALL persist immediately and set the channel's autonomy ceiling. The
selector SHALL seed from the persisted regime and reseed after a reload.

#### Scenario: Setting a channel to Open persists and round-trips
- **WHEN** a channel admin opens the channel AI tab, selects **Open** in the Agents section, and reloads the page
- **THEN** the regime selector reseeds to **Open** (the value was persisted via S2 and read back)

#### Scenario: Non-admin sees the regime read-only
- **WHEN** a non-admin member views the channel's autonomy regime
- **THEN** the regime is shown read-only with no writable selector

### Requirement: Swarm regime requires explicit confirmation
Selecting **Agent channel (Swarm)** SHALL NOT persist directly; it SHALL open a confirm dialog warning
that the mode is expensive and experimental and lifts the agent→agent firewall. Confirming SHALL persist
the swarm regime + its ceiling; cancelling SHALL revert the selector to its prior value.

#### Scenario: Choosing Agent channel prompts a confirm before persisting
- **WHEN** an admin clicks **Agent channel (Swarm)**
- **THEN** a confirm dialog appears, and the regime is only persisted after the admin confirms; cancelling restores the previous regime

### Requirement: Per-cybo autonomy level control on the cybo Overview
The cybo detail Overview tab SHALL provide an "Autonomy" section with four presets —
**Off**, **Mention-only**, **Active**, **Autonomous** — without adding a new tab. Selecting a preset
SHALL persist the cybo's autonomy level and reseed after a reload. When no persisted level exists, the
control SHALL seed by mapping the legacy `behaviorMode` (`responsive`→Mention-only, `proactive`→Active).

#### Scenario: Selecting a cybo preset persists and round-trips
- **WHEN** a user opens a cybo's Overview, selects the **Active** preset, and reloads
- **THEN** the **Active** preset is shown selected

### Requirement: Advanced disclosure exposes the 7 autonomy axes
The cybo Autonomy control SHALL include an "Advanced" disclosure, collapsed by default, that exposes the
seven interaction-autonomy axes (trigger/initiative, goal-source, social-scope, action-scope, oversight,
continuity, capability) as individual controls for power users. Selecting a preset SHALL reset the axes to
that preset's defaults; editing an axis SHALL persist the override alongside the level.

#### Scenario: Advanced disclosure is collapsed by default and expandable
- **WHEN** a user views the cybo Autonomy section
- **THEN** the Advanced disclosure is collapsed, and clicking it reveals the seven axis controls

### Requirement: Effective autonomy level surfaced in channel context
Wherever a cybo is shown in a channel context (channel Members list and the Agents section), the UI SHALL
display the effective level as `min(cyboLevel, channelCeiling)` with the label "Effective here: X", and
SHALL append "(capped by channel)" when the channel ceiling lowers the cybo's own level.

#### Scenario: A capped cybo shows the channel-capped effective level
- **WHEN** a cybo set to **Autonomous** appears in a **Mention-only** channel
- **THEN** its effective-level badge reads the mention-only label with "(capped by channel)"

#### Scenario: Raising the channel ceiling updates the effective level
- **WHEN** the channel regime is raised from **Mention-only** to **Open** for that same **Autonomous** cybo
- **THEN** the effective-level badge updates to `min(Autonomous, Open)` (the Open ceiling)
