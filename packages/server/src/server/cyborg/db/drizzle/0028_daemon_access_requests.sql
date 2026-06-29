-- daemon_access_requests: the REQUEST → NOTIFY → APPROVE half of #705. A non-owner
-- asks a daemon OWNER for access at a requested set of scopes; the owner approves
-- (running the existing grant via setDaemonAccess) or denies. The inbound
-- counterpart to daemon_access (the grant). One PENDING request per
-- (workspace, daemon, requester), enforced by the partial unique index below —
-- mirroring invitations' one-pending-per-(workspace,email) pattern.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / INDEX IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention — see
-- 0021_agent_session_usage.sql / 0008_drafts.sql and drizzle/RUNBOOK.md.
-- Hand-authored because drizzle-kit generate is blocked by the pre-existing
-- 0008/0009/0010 snapshot collision; the runtime migrator applies plain .sql +
-- _journal.json. Safe no-op on a DB that already has the table.
--
-- BACK-COMPAT: a brand-new table touched by nothing else — pre-existing rows in
-- other tables are unaffected. FKs cascade-delete on workspace/daemon/requester
-- removal; resolved_by is a plain (nullable) FK with no cascade.
CREATE TABLE IF NOT EXISTS "daemon_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"daemon_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"requester_name" text,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "daemon_access_requests" ADD CONSTRAINT "daemon_access_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "daemon_access_requests" ADD CONSTRAINT "daemon_access_requests_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "daemon_access_requests" ADD CONSTRAINT "daemon_access_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "daemon_access_requests" ADD CONSTRAINT "daemon_access_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemon_access_requests_workspace" ON "daemon_access_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemon_access_requests_daemon" ON "daemon_access_requests" USING btree ("daemon_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemon_access_requests_requester" ON "daemon_access_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_daemon_access_requests_pending" ON "daemon_access_requests" USING btree ("workspace_id","daemon_id","requester_id") WHERE "status" = 'pending';
