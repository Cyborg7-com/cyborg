-- Outgoing webhooks, Plane-grade (#598) — a NEW feature. Three tables:
--   * outgoing_webhooks      — workspace+channel-scoped OUTBOUND webhook config
--                              (url, hashed secret_key, per-event flags, active,
--                               failure bookkeeping). Distinct from the inbound
--                               `webhooks` table.
--   * webhook_outbox         — durable per-(event,webhook) delivery queue; claimed
--                              FOR UPDATE SKIP LOCKED by the delivery runner.
--                              Idempotency: UNIQUE(event_id, webhook_id).
--   * webhook_delivery_logs  — per-attempt audit (status, error_code, retry_count,
--                              next_retry_at).
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / CREATE INDEX IF NOT
-- EXISTS, guarded ALTER TABLE ... ADD CONSTRAINT), matching the repo's
-- hand-applied-prod convention — see 0010_scheduled_messages.sql /
-- 0006_webhook_cybo_triggers.sql / RUNBOOK.md. Safe no-op on a DB that already
-- has the tables; brand-new tables → no existing row is touched, no regression.
--
-- NOTE (parallel squads): this is journal idx 10 (file 0011). Sibling features
-- are landing in parallel and may also claim 0011/0012; the CTO reconciles the
-- snapshots + meta/_journal across the features at integration. The gap is
-- intentional deconfliction.

CREATE TABLE IF NOT EXISTS "outgoing_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"name" text DEFAULT 'Webhook' NOT NULL,
	"url" text NOT NULL,
	"secret_key" text NOT NULL,
	"events" jsonb DEFAULT '{"message.created":true}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_data" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_delivery_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"outbox_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"error_code" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- FKs match schema.ts: workspace/channel/creator cascade-delete on the config;
-- outbox + logs cascade on workspace AND on their parent webhook. Guarded so a
-- re-run is a no-op.
DO $$ BEGIN
	ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_webhook_id_outgoing_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."outgoing_webhooks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_delivery_logs" ADD CONSTRAINT "webhook_delivery_logs_webhook_id_outgoing_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."outgoing_webhooks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_delivery_logs" ADD CONSTRAINT "webhook_delivery_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outgoing_webhooks_workspace" ON "outgoing_webhooks" USING btree ("workspace_id");--> statement-breakpoint
-- Hot enqueue lookup: active webhooks for a channel on each message event.
CREATE INDEX IF NOT EXISTS "idx_outgoing_webhooks_channel_active" ON "outgoing_webhooks" USING btree ("channel_id","is_active");--> statement-breakpoint
-- Exactly-once-per-webhook enqueue guard (idempotency on event + webhook).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_webhook_outbox_event_webhook" ON "webhook_outbox" USING btree ("event_id","webhook_id");--> statement-breakpoint
-- Hot due-row scan: only undelivered rows, ordered by next_retry_at (partial
-- index keeps it tiny as delivered rows accumulate).
CREATE INDEX IF NOT EXISTS "idx_webhook_outbox_due" ON "webhook_outbox" USING btree ("next_retry_at") WHERE "webhook_outbox"."delivered_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_outbox_webhook" ON "webhook_outbox" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_logs_webhook_created" ON "webhook_delivery_logs" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_logs_outbox" ON "webhook_delivery_logs" USING btree ("outbox_id");
