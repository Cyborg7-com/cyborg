-- agent_bindings: durable PG mirror of the daemon's LOCAL SQLite agent_bindings.
-- A non-ephemeral agent session writes a binding to the owning daemon's SQLite,
-- which was never shared — so when that daemon closed or restarted the session
-- vanished from the cloud list (the relay lists sessions by fanning out to ONLINE
-- daemons, with nothing in PG to fall back on). Mirroring the non-ephemeral
-- bindings here lets the relay's list_agents fan-out show a workspace's sessions as
-- offline/not-live rows when the daemon is asleep, and they reappear (resumable)
-- once it reconnects. Ephemeral summons are NEVER written here.
--
-- initiated_by is the daemon-LOCAL SQLite user id (no FK — meaningless globally);
-- initiated_by_email is the stable cross-namespace identity the relay filters /
-- bridges on. workspace_id / channel_id cascade-delete with their parents.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / INDEX IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention — see
-- 0028_daemon_access_requests.sql / 0021_agent_session_usage.sql and
-- drizzle/RUNBOOK.md. Hand-authored because drizzle-kit generate is blocked by the
-- pre-existing 0008/0009/0010 snapshot collision; the runtime migrator applies
-- plain .sql + _journal.json. Safe no-op on a DB that already has the table.
CREATE TABLE IF NOT EXISTS "agent_bindings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text,
	"provider" text NOT NULL,
	"model" text,
	"system_prompt" text,
	"daemon_id" text,
	"cybo_id" text,
	"initiated_by" text,
	"initiated_by_email" text,
	"cwd" text,
	"provider_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_bindings_workspace" ON "agent_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_bindings_daemon" ON "agent_bindings" USING btree ("daemon_id");
