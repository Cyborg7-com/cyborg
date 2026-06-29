CREATE TABLE "activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"channel_id" text,
	"dm_peer_id" text,
	"preview_text" text,
	"actor_id" text,
	"actor_name" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_channel_assignments" (
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_channel_assignments_agent_id_channel_id_pk" PRIMARY KEY("agent_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text,
	"user_id" text,
	"provider_session_id" text,
	"title" text,
	"session_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"summary" text,
	"cwd" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "archived_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_handle_id" text NOT NULL,
	"title" text,
	"cwd" text,
	"model" text,
	"cybo_id" text,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"channel_id" text NOT NULL,
	"user_id" text,
	"cybo_id" text,
	"member_type" text DEFAULT 'human' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_user_uniq" UNIQUE("channel_id","user_id"),
	CONSTRAINT "channel_members_one_member" CHECK (("channel_members"."user_id" IS NOT NULL) <> ("channel_members"."cybo_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "channel_projects" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_roles" (
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_roles_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"instructions" text,
	"slash_command_model" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cybos" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"role" text,
	"soul" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"mcp_servers" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"llm_auth_mode" text DEFAULT 'cli' NOT NULL,
	"behavior_mode" text DEFAULT 'responsive' NOT NULL,
	"monthly_spend_cap" integer,
	"platform_permissions" jsonb DEFAULT '[]'::jsonb,
	"off_platform_permissions" jsonb DEFAULT '[]'::jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daemon_access" (
	"workspace_id" text NOT NULL,
	"daemon_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daemon_access_workspace_id_daemon_id_user_id_pk" PRIMARY KEY("workspace_id","daemon_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "daemon_agents" (
	"daemon_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daemon_agents_daemon_id_agent_id_pk" PRIMARY KEY("daemon_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "daemons" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"public_key" text,
	"last_seen_at" timestamp with time zone,
	"status" text DEFAULT 'offline' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_reads" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"peer_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_reads_workspace_id_user_id_peer_id_pk" PRIMARY KEY("workspace_id","user_id","peer_id")
);
--> statement-breakpoint
CREATE TABLE "email_otps" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"name" text,
	"password_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"purpose" text DEFAULT 'signup' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fcm_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fcm_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"identity_type" text NOT NULL,
	"identity_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"membership_type" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reads_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text,
	"from_id" text NOT NULL,
	"from_type" text NOT NULL,
	"from_name" text,
	"to_id" text,
	"text" text NOT NULL,
	"mentions" jsonb,
	"parent_id" text,
	"attachments" jsonb,
	"reactions" jsonb,
	"unfurls" jsonb,
	"pinned_at" timestamp with time zone,
	"pinned_by" text,
	"source" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"preference" text NOT NULL,
	CONSTRAINT "notification_prefs_user_id_scope_id_pk" PRIMARY KEY("user_id","scope_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"cybo_id" text NOT NULL,
	"channel_id" text,
	"cron_expr" text NOT NULL,
	"timezone" text,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_aliases" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"alias" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_aliases_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text NOT NULL,
	"price_id" text,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"assignee_id" text,
	"created_by" text NOT NULL,
	"due_at" timestamp with time zone,
	"recurrence" text,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_memberships" (
	"root_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"last_viewed" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_mentions" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_memberships_root_id_user_id_pk" PRIMARY KEY("root_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"root_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone DEFAULT now() NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"is_away" boolean DEFAULT false NOT NULL,
	"dnd_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text,
	"text" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image_url" text,
	"password_hash" text,
	"default_slash_daemon_id" text,
	"slash_command_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_daemons" (
	"workspace_id" text NOT NULL,
	"daemon_id" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "workspace_daemons_workspace_id_daemon_id_pk" PRIMARY KEY("workspace_id","daemon_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_sequences" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"avatar_url" text,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"default_slash_daemon_id" text,
	"slash_command_fallback_daemons" jsonb DEFAULT '[]'::jsonb,
	"slash_command_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_assignments" ADD CONSTRAINT "agent_channel_assignments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_assignments" ADD CONSTRAINT "agent_channel_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_sessions" ADD CONSTRAINT "archived_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_cybo_id_cybos_id_fk" FOREIGN KEY ("cybo_id") REFERENCES "public"."cybos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_projects" ADD CONSTRAINT "channel_projects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_projects" ADD CONSTRAINT "channel_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cybos" ADD CONSTRAINT "cybos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access" ADD CONSTRAINT "daemon_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access" ADD CONSTRAINT "daemon_access_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access" ADD CONSTRAINT "daemon_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access" ADD CONSTRAINT "daemon_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_agents" ADD CONSTRAINT "daemon_agents_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_agents" ADD CONSTRAINT "daemon_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemons" ADD CONSTRAINT "daemons_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_reads" ADD CONSTRAINT "dm_reads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_reads" ADD CONSTRAINT "dm_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fcm_tokens" ADD CONSTRAINT "fcm_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_cybo_id_cybos_id_fk" FOREIGN KEY ("cybo_id") REFERENCES "public"."cybos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_aliases" ADD CONSTRAINT "session_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_statuses" ADD CONSTRAINT "user_statuses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_statuses" ADD CONSTRAINT "user_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_slash_daemon_id_daemons_id_fk" FOREIGN KEY ("default_slash_daemon_id") REFERENCES "public"."daemons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_daemons" ADD CONSTRAINT "workspace_daemons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_daemons" ADD CONSTRAINT "workspace_daemons_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sequences" ADD CONSTRAINT "workspace_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_slash_daemon_id_daemons_id_fk" FOREIGN KEY ("default_slash_daemon_id") REFERENCES "public"."daemons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_user_ws_created" ON "activity_events" USING btree ("user_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_channel_channel" ON "agent_channel_assignments" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_agent" ON "agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_workspace" ON "agent_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_channel_date" ON "agent_sessions" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_archived_sessions_workspace" ON "archived_sessions" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_audit_workspace_time" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_channel_members_channel" ON "channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_cybo_uniq" ON "channel_members" USING btree ("channel_id","cybo_id") WHERE "channel_members"."cybo_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_channel_roles_channel" ON "channel_roles" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_channels_workspace_name" ON "channels" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cybos_workspace_slug" ON "cybos" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "idx_cybos_workspace" ON "cybos" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_daemon_access_workspace" ON "daemon_access" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_daemon_agents_workspace" ON "daemon_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_dm_reads_user_ws" ON "dm_reads" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_fcm_tokens_user" ON "fcm_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_invitations_workspace" ON "invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_invitations_email" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_invitations_pending_workspace_email" ON "invitations" USING btree ("workspace_id","email") WHERE "invitations"."accepted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_mcp_tokens_workspace" ON "mcp_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tokens_hash" ON "mcp_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_message_reads_user_ws" ON "message_reads" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_seq" ON "messages" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE INDEX "idx_messages_workspace_seq" ON "messages" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_created" ON "messages" USING btree ("channel_id","created_at","seq");--> statement-breakpoint
CREATE INDEX "idx_messages_workspace_created" ON "messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_to_ws_created" ON "messages" USING btree ("to_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_from_ws_created" ON "messages" USING btree ("from_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_prefs_user_ws" ON "notification_prefs" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_projects_workspace" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_push_subscriptions_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_workspace" ON "schedules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_due" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace_status" ON "tasks" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_threadmemb_user_ws" ON "thread_memberships" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_threads_ws_lastreply" ON "threads" USING btree ("workspace_id","last_reply_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_statuses_workspace_user" ON "user_statuses" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_user_statuses_workspace" ON "user_statuses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_user_statuses_expires_at" ON "user_statuses" USING btree ("expires_at");