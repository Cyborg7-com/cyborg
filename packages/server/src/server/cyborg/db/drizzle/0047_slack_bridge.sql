-- 0047_slack_bridge.sql
-- Slack customer-comms bridge — WAVE 1 foundation: provider-agnostic integration
-- installs + Slack channel/user/message mappings.
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention (see 0034_github_sync.sql / 0044). Hand-authored
-- because drizzle-kit generate is blocked by the pre-existing 0008/0009/0010
-- snapshot collision; the runtime migrator applies plain .sql + _journal.json.
-- Safe to run twice.
--
-- WAVE 1 locks the storage contract ONLY. The Slack Events endpoint, OAuth, and
-- UI ship in WAVE 2; nothing here reads/writes Slack at runtime yet.
--
-- Tables:
--   integration_installations — one row per external integration install on a
--     workspace. Provider-agnostic (Slack today; Jira/ClickUp later) — `provider`
--     discriminates. UNIQUE(workspace_id, provider, external_id): one install per
--     (workspace, provider, external team/enterprise id). access_token is stored
--     as returned by the provider — TODO(security): encrypt at rest in a follow-up
--     (note, don't block). Nullable: not every provider stores a long-lived token
--     (e.g. a GitHub App mints per-call).
--   slack_channel_links — (Slack channel ↔ Cyborg channel) bindings. FKs CASCADE on
--     workspace / installation / cyborg channel. UNIQUE(slack_channel_id): a given
--     Slack channel mirrors into exactly one Cyborg channel; index(cyborg_channel_id)
--     is the outbound "is this channel Slack-linked?" lookup.
--   slack_user_map — (Slack team,user) → synthetic Cyborg guest user (the ensureUser
--     id, e.g. `slack:<team>:<user>`). UNIQUE(slack_team_id, slack_user_id).
--   message_integrations — Cyborg message ↔ provider external id (Slack ts) map,
--     provider-agnostic (future-proofs GitHub). message_id PK; external_thread_id
--     carries the Slack thread_ts; index(provider, external_id) is the inbound
--     reverse lookup + echo guard.

CREATE TABLE IF NOT EXISTS "integration_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_token" text,
	"bot_user_id" text,
	"scopes" text,
	"installed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integration_installations_workspace" ON "integration_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_installations_ws_provider_external" ON "integration_installations" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_channel_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"installation_id" text NOT NULL REFERENCES "integration_installations"("id") ON DELETE CASCADE,
	"cyborg_channel_id" text NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
	"slack_channel_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"sync_direction" text DEFAULT 'bidirectional' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_channel_links_workspace" ON "slack_channel_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_channel_links_cyborg_channel" ON "slack_channel_links" USING btree ("cyborg_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_channel_links_slack_channel" ON "slack_channel_links" USING btree ("slack_channel_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_user_map" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"synthetic_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_user_map_team_user" ON "slack_user_map" USING btree ("slack_team_id","slack_user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_integrations" (
	"message_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"external_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- UNIQUE so inbound dedupe is atomic (two concurrent mirrors of the same Slack ts
-- can't both create a row). Keyed (provider, external_id, workspace_id): a Slack ts is
-- unique per channel, NOT globally, so scoping by workspace avoids one tenant's ts
-- colliding with another's; (provider, external_id) stays the leading prefix so the
-- inbound reverse lookup (WHERE provider=? AND external_id=?) is still index-served.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_message_integrations_provider_external" ON "message_integrations" USING btree ("provider","external_id","workspace_id");
