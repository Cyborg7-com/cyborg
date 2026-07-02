CREATE TABLE IF NOT EXISTS "user_identity_aliases" (
	"local_id" text PRIMARY KEY NOT NULL,
	"canonical_id" text NOT NULL,
	"email" text,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_identity_aliases" ADD CONSTRAINT "user_identity_aliases_canonical_id_users_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_identity_aliases_canonical" ON "user_identity_aliases" USING btree ("canonical_id");
