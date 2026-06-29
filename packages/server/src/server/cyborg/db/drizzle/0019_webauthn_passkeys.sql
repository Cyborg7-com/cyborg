-- WebAuthn / passkeys. Two tables backing passwordless (Touch ID / Face ID /
-- security-key) login + passkey management for both the cloud relay and any
-- self-hosted relay deployment (both run on PostgreSQL).
--
-- Authored by hand (not `drizzle-kit generate`) because the repo's migration
-- snapshots have a pre-existing 0008/0009/0010 collision that blocks codegen;
-- the runtime migrator only reads _journal.json + these .sql files, so this
-- applies cleanly. Additive + IDEMPOTENT (IF NOT EXISTS, inline constraints),
-- matching the repo's hand-applied-prod convention — re-running is a safe no-op.

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"credential_id" text NOT NULL UNIQUE,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
	"key" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webauthn_creds_user" ON "webauthn_credentials" USING btree ("user_id");
