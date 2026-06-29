-- terminal_aliases: the server-backed half of terminal rename. A per-user,
-- display-only label a user gives a terminal session so they can spot it. The
-- counterpart to session_aliases (one per agent session) — a terminal is private
-- to whoever opened it (terminal_output/terminals_changed are owner-scoped), so a
-- terminal alias is per-user too. PK (user_id, terminal_id): one alias per user
-- per terminal. Replaces the old device-local localStorage map so a rename syncs
-- across the user's devices.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention — see
-- 0028_daemon_access_requests.sql / 0021_agent_session_usage.sql and
-- drizzle/RUNBOOK.md. Hand-authored because drizzle-kit generate is blocked by
-- the pre-existing 0008/0009/0010 snapshot collision; the runtime migrator
-- applies plain .sql + _journal.json. Safe no-op on a DB that already has it.
--
-- BACK-COMPAT: a brand-new table touched by nothing else — pre-existing rows in
-- other tables are unaffected. The user_id FK cascade-deletes the user's aliases
-- when the user is removed.
CREATE TABLE IF NOT EXISTS "terminal_aliases" (
	"user_id" text NOT NULL,
	"terminal_id" text NOT NULL,
	"alias" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_aliases_user_id_terminal_id_pk" PRIMARY KEY("user_id","terminal_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "terminal_aliases" ADD CONSTRAINT "terminal_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
