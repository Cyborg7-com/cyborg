-- License pool + allocation model (per-workspace billing across Stripe + iOS).
-- A POOL is one buyer's seat entitlement on one rail (iOS: one per user, seats =
-- tier; Stripe: optional, see spec §3). An ALLOCATION spends one seat on one
-- workspace. A workspace is Pro iff it has an allocation whose pool is in good
-- standing. The per-workspace `subscriptions` row stays as the gate's cache,
-- recomputed (derived) from allocations — getLicenseStatus is unchanged.
--
-- Additive + IDEMPOTENT (CREATE TABLE / CREATE INDEX IF NOT EXISTS, guarded FK +
-- unique adds), matching the repo's hand-applied-prod convention — see
-- 0009_saved_messages.sql / 0014_group_dm_channels.sql. Brand-new tables touch
-- nothing existing; a re-run is a safe no-op. The grandfather backfill (spec §5)
-- runs SEPARATELY as a guarded data script AFTER this migration + the new
-- reconcile code are deployed — it is NOT in this DDL file.
--
-- NOTE (Drizzle journal): this is journal idx 14 / file 0015. Snapshots in meta/
-- are stale from 0010 (parallel-squad debt) — the CTO reconciles snapshots
-- separately; the relay applies this .sql on boot regardless.

CREATE TABLE IF NOT EXISTS "license_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"rail" text NOT NULL,
	"seat_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"product_id" text,
	"entitlement_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "license_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "license_pools" ADD CONSTRAINT "license_pools_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "license_allocations" ADD CONSTRAINT "license_allocations_pool_id_license_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."license_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "license_allocations" ADD CONSTRAINT "license_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_license_pools_owner" ON "license_pools" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_license_pools_owner_rail" ON "license_pools" USING btree ("owner_user_id","rail");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_license_allocations_workspace" ON "license_allocations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_license_allocations_pool" ON "license_allocations" USING btree ("pool_id");
