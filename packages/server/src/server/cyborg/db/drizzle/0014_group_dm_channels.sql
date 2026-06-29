-- Group DMs via hidden group_dm channels (#608) — Mattermost parity. A group DM
-- is just a CHANNEL with type='group_dm' + is_hidden=true: it reuses the entire
-- channel message pipeline (threads / unread / reads / channel_members) instead
-- of the 1:1 to_id path, but is HIDDEN from the channel browser and lists under
-- the DM section for its members. Regular channels are unchanged: the two new
-- columns default to ('regular', false), so every existing row stays byte-identical.
--
-- Additive + backward-compatible + IDEMPOTENT (ALTER ... ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, guarded constraint adds), matching the repo's
-- hand-applied-prod convention — see 0002_webhooks_and_message_card.sql (ADD
-- COLUMN IF NOT EXISTS) / 0009_saved_messages.sql (guarded constraint). A re-run
-- is a safe no-op; nothing existing is touched.
--
-- NOTE (parallel squads): siblings add other features in parallel on adjacent
-- indices; this is journal idx 12 / file 0013. The CTO reconciles the Drizzle
-- snapshots + journal across the parallel features at integration.
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Constrain `type` to the known kinds so a stray value can never reach the
-- visibility/routing logic. Add NOT VALID first (a metadata-only change that does
-- NOT scan/lock the table under ACCESS EXCLUSIVE), then VALIDATE separately (a
-- cheaper SHARE UPDATE EXCLUSIVE scan). Guarded so a re-run is a no-op, and
-- VALIDATE on an already-valid constraint is itself a no-op.
DO $$ BEGIN
	ALTER TABLE "channels" ADD CONSTRAINT "channels_type_valid" CHECK ("type" IN ('regular', 'group_dm')) NOT VALID;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "channels" VALIDATE CONSTRAINT "channels_type_valid";--> statement-breakpoint
-- Hot path for the browser/sidebar lists, which fetch only VISIBLE (non-hidden)
-- channels per workspace. Partial so the index stays tiny and only covers the
-- rows those queries actually scan (is_hidden = false). The predicate already
-- constrains is_hidden, so the index keys workspace_id only.
CREATE INDEX IF NOT EXISTS "idx_channels_workspace_visible" ON "channels" USING btree ("workspace_id") WHERE "is_hidden" = false;
