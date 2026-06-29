-- Inbound webhooks (GitHub-style config) + structured message cards.
--
-- Additive + backward-compatible. IF NOT EXISTS / guarded constraint adds keep
-- this a safe no-op on a DB that already has these (matching the repo's
-- hand-applied-prod convention — see 0001_message_search_tsv.sql).

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event" text,
	"action" text,
	"request_headers" jsonb,
	"request_body" text,
	"response_status" integer NOT NULL,
	"response_body" text,
	"ok" boolean NOT NULL,
	"redelivered_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text DEFAULT 'Webhook' NOT NULL,
	"secret" text,
	"content_type" text DEFAULT 'application/json' NOT NULL,
	"event_mode" text DEFAULT 'release' NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "card" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_channel" ON "webhook_deliveries" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_channel" ON "webhooks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_workspace" ON "webhooks" USING btree ("workspace_id");
