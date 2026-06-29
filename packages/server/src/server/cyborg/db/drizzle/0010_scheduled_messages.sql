-- User "send later" scheduled posts (#607) — a NEW user-facing feature, distinct
-- from the recurring cybo `schedules` table (cronExpr automation). A row is a
-- single deferred human message (channel OR DM); a due-row job fires it via the
-- NORMAL message path and stamps processed_at, setting a CLOSED-SET error_code on
-- failure (the Mattermost ScheduledPost.ErrorCode lesson — a failed scheduled send
-- is never silently dropped).
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / CREATE INDEX IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention — see
-- 0006_webhook_cybo_triggers.sql / 0005_daemon_access_scopes.sql / RUNBOOK.md. Safe
-- no-op on a DB that already has the table. Brand-new table → no existing row is
-- touched, no regression.
--
-- NOTE (parallel squads): siblings add 0007 (saved messages) + 0008 (drafts) in
-- parallel; this is 0009. The CTO renumbers at merge if the order collides.
CREATE TABLE IF NOT EXISTS "scheduled_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text,
	"to_id" text,
	"from_id" text NOT NULL,
	"text" text NOT NULL,
	"mentions" jsonb,
	"send_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- FKs match schema.ts: workspace/author cascade-delete; a deleted channel is
-- null'd (the runner then fails the row `channel_not_found`/`channel_archived`
-- rather than leaving an unfireable orphan). Guarded so a re-run is a no-op.
DO $$ BEGIN
	ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_messages_workspace" ON "scheduled_messages" USING btree ("workspace_id","send_at");--> statement-breakpoint
-- Hot due-row scan: only unprocessed rows, ordered by send_at (partial index keeps
-- it tiny as processed rows accumulate).
CREATE INDEX IF NOT EXISTS "idx_scheduled_messages_due" ON "scheduled_messages" USING btree ("send_at") WHERE "scheduled_messages"."processed_at" IS NULL;
