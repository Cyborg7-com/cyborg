-- Daemon deployment edition (usage-metrics, round 1). A dedicated, nullable
-- column mirroring deployment_mode so the superadmin usage dashboard can do a
-- cheap GROUP BY edition without reaching into the daemons.meta jsonb. The same
-- value is also persisted into meta.edition by the heartbeat/hello merge; this
-- column is the indexed/aggregatable copy.
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention — re-running is a safe no-op. Nullable: an older
-- daemon that doesn't report `edition` leaves the column NULL ('unknown').
--
-- NOTE (Drizzle journal): journal idx 17 / file 0018. Snapshots in meta/ are
-- stale from 0010 (parallel-squad debt, see 0017) — no per-index snapshot is
-- authored here; the relay applies this .sql on boot regardless. The journal
-- `when` is hand-stamped ABOVE the live applied max (0016 = 1782400000000) so
-- the stock migrator does not skip it.

ALTER TABLE "daemons" ADD COLUMN IF NOT EXISTS "deployment_edition" text;
