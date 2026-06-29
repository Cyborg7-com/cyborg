# Tasks epic — module index

The auto-tasks / channel-watcher / scheduling subsystem, split across the small
focused modules below. Each row is "what it is" + where it lives. For the
end-to-end flow these wire together (human post → watcher gate → prefilter →
chain → spawn → dispatch → logs), read the pipeline doc:

> `internal docs`

## Modules

| Module | What it is | Path |
| --- | --- | --- |
| watcher-prefilter | Pure eligibility gate (`shouldConsiderWatch`) — sheds idle small-talk before any spawn; lets a message through if the channel has open tasks OR the text reads actionable (EN/ES verb set). | `watcher-prefilter.ts` |
| chain-router | Pure, zero-I/O ordered first-viable failover walk (`runFallbackChain`). The de-duplicated core both watcher loops share. Deterministic fallback — NOT a Markov chain. | `chain-router.ts` |
| message-router watcher path | Daemon-LOCAL watcher: `invokeChannelWatchers` (gates + prefilter + chain resolution) → `runWatcherFailover` (spawn the first chain cybo this daemon can run). Called fire-and-forget from the human channel-post path. | `message-router.ts` (`invokeChannelWatchers` :665, `runWatcherFailover` :841, call site :1411) |
| cybo-mention-invoke relay path | CLOUD watcher: `invokeChannelWatchersViaRelay` (chain + prompt) → `forwardWatchToChain` (forward the invoke to the first chain cybo whose owning daemon is online + capability-matched, via `pickMentionDaemon`). Also holds the watch dedup guard. | `cybo-mention-invoke.ts` (`invokeChannelWatchersViaRelay` :910, `forwardWatchToChain` :1068, `pickMentionDaemon` :115, `watchInvocationGuard` :282) |
| cybo-manager spawn | `spawnCybo` — the one ephemeral-cybo spawn used by every path (watcher, mention, task dispatch, schedule). Ephemeral = `internal:true` + `persistSession:false`; claude ephemerals get `modeId:bypassPermissions`. | `cybo-manager.ts` (`spawnCybo` :109) |
| task-dispatch | `dispatchTaskToAgent` (atomic-claim execute-dispatch), recurrence math (`computeNextRecurrence`), `spawnNextRecurrence`, `catchUpOwnedTasks`. | `task-dispatch.ts` |
| task-event-log | Pure discriminated-union of pipeline events + `formatTaskEvent` → the `cyborg:task_event` envelope the Logs pane renders. | `task-event-log.ts` |
| task-activity | Pure derivation (`taskActivityEvents`) of per-recipient activity-feed rows (assigned / status-changed) for human members. | `task-activity.ts` |
| schedule-runner | Per-daemon 60s tick: fires due cron schedules AND due agent-assigned tasks (`dispatchDueTasks`) from the same timer; hosts the `additionalTick` seam. | `schedule-runner.ts` (`tick` :116, `dispatchDueTasks` :263) |
| scheduled-message-runner | Daemon-side "send later" runner — no timer of its own; pumped by the schedule-runner tick. Solo-daemon fires; a connected daemon defers to the relay's PG tick. | `scheduled-message-runner.ts` |

## Callers (not part of the epic, but where it plugs in)

- **`dispatcher.ts`** — daemon `create_task` / `update_task` MCP-tool handlers:
  `maybeDispatchOnAssign` (immediate execute-dispatch, :3027) + `spawnNextRecurrence`
  on a recurring task flipped to done (:3130); emits `task_created` /
  `task_status_changed` Logs events.
- **`relay-standalone.ts`** — the cloud `cyborg:channel_message` block runs the
  watcher gate + `invokeChannelWatchersViaRelay` (:4069); the relay task handlers
  emit `taskActivityEvents` (:6802, :6898).
- **`db/pg-sync.ts`** — `getChannelCyboMembers` (join-ordered chain, :945),
  `getChannelAutoTasksEnabled` (the per-channel gate, :1169).
