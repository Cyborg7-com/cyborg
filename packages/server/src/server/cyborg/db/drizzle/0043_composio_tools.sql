-- Composio third-party tool integration for cybos (knowledge: composio-ownership-and-permissions).
--
-- Two additive pieces:
--   1. cybos.tool_grants (jsonb, nullable) — the `CyboToolGrants` capability blob
--      (which toolkits/actions the cybo MAY use + approval policy). Workspace-owned,
--      carries NO credentials. Nullable like mcp_servers ⇒ every pre-existing cybo
--      stays `tool_grants IS NULL` (no grants), so no behavior change.
--   2. composio_connections — one OAuth'd identity per (workspace, owner, toolkit).
--      We store only the Composio `connected_account_id` REFERENCE (tokens live in
--      Composio's vault, never here) + who owns it. UNIQUE per owner+toolkit ⇒ one
--      connection per identity per toolkit.
--
-- Additive + IDEMPOTENT (ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention — see 0017_license_pools_allocations.sql
-- / 0006_webhook_cybo_triggers.sql. Brand-new table touches nothing existing; a
-- re-run is a safe no-op. No FK on workspace_id (kept text, matching the loose
-- coupling the design calls for); cascade not required since rows are tiny refs.

ALTER TABLE "cybos" ADD COLUMN IF NOT EXISTS "tool_grants" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "composio_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_composio_connections_owner_toolkit" ON "composio_connections" USING btree ("workspace_id","owner_kind","owner_id","toolkit");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_composio_connections_workspace" ON "composio_connections" USING btree ("workspace_id");
