-- Reusable prompt templates in the composer (#602) — a NEW workspace-scoped,
-- member-facing feature. A row is a named, reusable message BODY a workspace
-- member can drop into the composer from the slash menu's secondary "Templates"
-- group; on SEND the body is expanded server-side ({channel}/{user}/{date} →
-- the final HTML-escaped context). DISTINCT from the scheduler's
-- webhooks.prompt_template column (a webhook-payload fire prompt) — that is
-- untouched here.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / CREATE INDEX IF
-- NOT EXISTS; guarded ADD CONSTRAINT), matching the repo's hand-applied-prod
-- convention — see 0010_scheduled_messages.sql / 0009_saved_messages.sql /
-- RUNBOOK.md. A brand-new table touches no existing row, so it is a safe no-op
-- on a DB that already has it and is never destructive. Validated to apply
-- twice with no error (re-run = no-op).
--
-- NOTE (parallel squads): this branch is one of three Tier-2 features cut in
-- parallel off cyborg; the assigned journal idx is 11 (file 0012), which may
-- leave a gap on this branch by design — the CTO reconciles snapshots + meta
-- across the three features at integration.
CREATE TABLE IF NOT EXISTS "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- FKs match schema.ts: a deleted workspace cascade-removes its templates; a
-- deleted author is NULL'd (SET NULL) so the workspace-owned template survives.
-- Guarded so a re-run is a no-op (duplicate_object → null).
DO $$ BEGIN
	ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One template NAME per workspace (case-sensitive). Unique → blocks duplicate
-- names (the create RPC maps the clash to a friendly error) and doubles as the
-- workspace-scoped list/lookup index.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_prompt_templates_workspace_name" ON "prompt_templates" USING btree ("workspace_id","name");
