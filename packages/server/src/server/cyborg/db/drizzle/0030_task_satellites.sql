-- 0029_task_satellites.sql
-- Tasks Redesign P0 — per-task satellites: labels, links, attachments, activity.
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention. Hand-authored (drizzle-kit generate blocked by the
-- pre-existing snapshot collision); the runtime migrator applies plain .sql +
-- _journal.json. Safe to run twice.

-- Per-project labels (free-form tags), many-to-many with tasks via
-- task_label_assignees. color is a hex pill color; sort_order is fractional.
CREATE TABLE IF NOT EXISTS "task_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" real NOT NULL
);
--> statement-breakpoint

-- Join table: which labels are on which task.
CREATE TABLE IF NOT EXISTS "task_label_assignees" (
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"label_id" text NOT NULL REFERENCES "task_labels"("id") ON DELETE CASCADE,
	CONSTRAINT "task_label_assignees_pkey" PRIMARY KEY ("task_id","label_id")
);
--> statement-breakpoint

-- External links attached to a task.
CREATE TABLE IF NOT EXISTS "task_links" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"url" text NOT NULL,
	"title" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- File attachments on a task (S3 asset_key + metadata).
CREATE TABLE IF NOT EXISTS "task_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"asset_key" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"content_type" text,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Per-task activity feed: a row per attribute change (verb=created|updated) and
-- per comment. field/old_value/new_value describe a change; comment_html is set
-- for comment rows. epoch is a fractional sort key (ms since epoch).
CREATE TABLE IF NOT EXISTS "task_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" text,
	"verb" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"comment_html" text,
	"epoch" double precision NOT NULL,
	CONSTRAINT "task_activity_verb_valid" CHECK ("verb" IN ('created', 'updated'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_task_labels_project" ON "task_labels" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_label_assignees_label" ON "task_label_assignees" USING btree ("label_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_links_task" ON "task_links" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_attachments_task" ON "task_attachments" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_activity_task_epoch" ON "task_activity" USING btree ("task_id","epoch");
