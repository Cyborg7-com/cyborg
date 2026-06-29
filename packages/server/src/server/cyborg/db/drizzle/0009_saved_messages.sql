-- Saved messages (#609): a PRIVATE per-user bookmark list, distinct from channel
-- pins (which are shared, stored as pinned_at/pinned_by on the messages row).
--
-- Additive + IDEMPOTENT (CREATE TABLE / CREATE INDEX IF NOT EXISTS), matching the
-- repo's hand-applied-prod convention — see 0006_webhook_cybo_triggers.sql /
-- 0005_daemon_access_scopes.sql. A brand-new table touches nothing existing, so
-- it is a safe no-op on a DB that already has it and never destructive.
--
-- ISOLATION: the composite PK (user_id, message_id) makes a save idempotent (a
-- re-save can't duplicate) and guarantees a user only ever sees their OWN saves.
-- A no-save state is the ROW NOT EXISTING. message_id is intentionally NOT a FK
-- to messages: a deleted message just leaves a harmless dangling saved row, and
-- the list join (getSavedMessages) drops tombstoned/missing messages anyway.
CREATE TABLE IF NOT EXISTS "saved_messages" (
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_messages_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_messages_user_created" ON "saved_messages" USING btree ("user_id","created_at");
