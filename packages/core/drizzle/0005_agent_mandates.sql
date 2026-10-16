CREATE TABLE "agent_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"actions" jsonb NOT NULL,
	"approve_cap_minor" bigint,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_mandates" ADD CONSTRAINT "agent_mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_mandates_token_hash" ON "agent_mandates" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_mandates_user" ON "agent_mandates" USING btree ("user_id");