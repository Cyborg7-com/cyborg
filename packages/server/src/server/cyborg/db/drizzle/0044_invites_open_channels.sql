-- Slack-parity workspace invites: reusable links + add-to-channels.
--
-- Extends the invitations table (additive, IDEMPOTENT, hand-applied-prod
-- convention — see 0043_composio_tools.sql):
--   1. email → NULLABLE. An OPEN (reusable) invite has NULL email + is_open=true:
--      anyone with the link can join, and accepting does NOT consume it.
--   2. is_open (bool, default false) — marks the one reusable link per workspace.
--   3. channel_ids (jsonb, default '[]') — channels the invitee is auto-joined to
--      on accept, on top of the default #general.
--
-- The pending-unique index is narrowed to email-bound rows so open invites
-- (NULL email) don't collide; a new partial-unique keeps at most ONE live
-- reusable link per workspace ("Reset" deletes the old row before inserting a new
-- token, so a rotation never trips it). Existing rows: is_open=false,
-- channel_ids='[]', email unchanged — no behavior change.

ALTER TABLE "invitations" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "is_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_invitations_pending_workspace_email";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitations_pending_workspace_email" ON "invitations" USING btree ("workspace_id","email") WHERE "invitations"."accepted_at" IS NULL AND "invitations"."is_open" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitations_open_workspace" ON "invitations" USING btree ("workspace_id") WHERE "invitations"."is_open" = true AND "invitations"."accepted_at" IS NULL;
