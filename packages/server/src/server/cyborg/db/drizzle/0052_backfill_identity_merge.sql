-- One-time identity merge (#34). A single human held TWO user rows: a duplicate
-- daemon-created id and their canonical cloud id. This seeds the alias for the one
-- VERIFIED pair (confirmed against prod: the canonical row 4871b232 owns the real
-- email/name/avatar; a6adce8d is the duplicate) and re-points every ownership
-- reference from ANY aliased local id to its canonical id. Fully driven by
-- user_identity_aliases, so it also fixes any pair a claim has recorded since 0051.
-- Idempotent + guarded (a no-op on any DB lacking the rows); the alias row and the
-- retired users row remain as an auditable, reversible tombstone.

INSERT INTO "user_identity_aliases" ("local_id", "canonical_id", "email")
SELECT
	'a6adce8d-c5e9-5937-8170-622f9b90624a',
	'4871b232-0d16-4105-93fc-ea15718cec44',
	'rodrigo.parisusao25201@gmail.com'
WHERE EXISTS (SELECT 1 FROM "users" WHERE "id" = '4871b232-0d16-4105-93fc-ea15718cec44')
	AND EXISTS (SELECT 1 FROM "users" WHERE "id" = 'a6adce8d-c5e9-5937-8170-622f9b90624a')
ON CONFLICT ("local_id") DO NOTHING;
--> statement-breakpoint
-- tasks: bare-text owner columns (no FK) — direct re-point.
UPDATE "tasks" AS t SET "assignee_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE t."assignee_id" = a."local_id";
--> statement-breakpoint
UPDATE "tasks" AS t SET "created_by" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE t."created_by" = a."local_id";
--> statement-breakpoint
-- agent_bindings / archived_sessions / audit_log: bare-text owner columns.
UPDATE "agent_bindings" AS b SET "initiated_by" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE b."initiated_by" = a."local_id";
--> statement-breakpoint
UPDATE "archived_sessions" AS s SET "initiated_by" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE s."initiated_by" = a."local_id";
--> statement-breakpoint
UPDATE "audit_log" AS l SET "actor_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE l."actor_id" = a."local_id";
--> statement-breakpoint
-- Ownership / creator columns (single-value FK, no PK collision): the canonical user
-- must keep ownership of their workspaces, daemons, schedules and webhooks — otherwise
-- those stay bound to the retired duplicate id and the real account loses control.
UPDATE "workspaces" AS w SET "owner_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE w."owner_id" = a."local_id";
--> statement-breakpoint
UPDATE "daemons" AS d SET "owner_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE d."owner_id" = a."local_id";
--> statement-breakpoint
UPDATE "schedules" AS sc SET "created_by" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE sc."created_by" = a."local_id";
--> statement-breakpoint
UPDATE "outgoing_webhooks" AS ow SET "created_by" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE ow."created_by" = a."local_id";
--> statement-breakpoint
-- memberships: composite PK (workspace_id, user_id) + FK to users. Drop the aliased
-- row where the canonical is ALREADY a member of that workspace, then re-point the
-- rest. (Role reconciliation is a no-op for the known pair — both are admin.)
DELETE FROM "memberships" m USING "user_identity_aliases" a
	WHERE m."user_id" = a."local_id"
	AND EXISTS (
		SELECT 1 FROM "memberships" m2
		WHERE m2."workspace_id" = m."workspace_id" AND m2."user_id" = a."canonical_id"
	);
--> statement-breakpoint
UPDATE "memberships" m SET "user_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE m."user_id" = a."local_id";
--> statement-breakpoint
-- channel_members: composite PK (channel_id, user_id) + FK to users. Same dedup.
DELETE FROM "channel_members" cm USING "user_identity_aliases" a
	WHERE cm."user_id" = a."local_id"
	AND EXISTS (
		SELECT 1 FROM "channel_members" cm2
		WHERE cm2."channel_id" = cm."channel_id" AND cm2."user_id" = a."canonical_id"
	);
--> statement-breakpoint
UPDATE "channel_members" cm SET "user_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE cm."user_id" = a."local_id";
--> statement-breakpoint
-- channel_roles: composite PK (channel_id, user_id) + FK to users. Same dedup so a
-- custom channel role (e.g. channel admin) on the duplicate isn't orphaned.
DELETE FROM "channel_roles" cr USING "user_identity_aliases" a
	WHERE cr."user_id" = a."local_id"
	AND EXISTS (
		SELECT 1 FROM "channel_roles" cr2
		WHERE cr2."channel_id" = cr."channel_id" AND cr2."user_id" = a."canonical_id"
	);
--> statement-breakpoint
UPDATE "channel_roles" cr SET "user_id" = a."canonical_id"
	FROM "user_identity_aliases" a WHERE cr."user_id" = a."local_id";
