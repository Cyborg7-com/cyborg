-- Server-side draft sync (#610): drafts follow the user across devices.
--
-- A per-(user, scope) composer draft. `scope` identifies the conversation the
-- draft belongs to (channel:<id> / dm:<peerId> / thread:<rootId>) — the same
-- opaque key the UI drafts store already uses. Only the TEXT is synced (pending
-- File attachments hold live blobs that can't cross devices). `updated_at` is the
-- reconcile tiebreaker — newest write wins when a device's local cache and the
-- server disagree on workspace load.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / INDEX IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention — see
-- 0006_webhook_cybo_triggers.sql / 0005_daemon_access_scopes.sql and the
-- drizzle/RUNBOOK.md. Safe no-op on a DB that already has the table.
--
-- BACK-COMPAT: a brand-new table touched by nothing else — pre-existing rows in
-- other tables are unaffected, and the existing localStorage drafts keep working
-- unchanged (this server layer is purely additive cross-device sync; no data
-- loss if a client is offline). The (user_id, scope) primary key gives one draft
-- per conversation per user; an upsert overwrites it, a send/clear deletes it.
CREATE TABLE IF NOT EXISTS "drafts" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drafts_user_ws" ON "drafts" USING btree ("user_id","workspace_id");
