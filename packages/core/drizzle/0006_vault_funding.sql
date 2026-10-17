CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'paypal' NOT NULL,
	"paypal_payment_token_id" text NOT NULL,
	"paypal_customer_id" text,
	"payer_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vault_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"setup_token_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mandates" ADD COLUMN "fund_cap_minor" bigint;--> statement-breakpoint
ALTER TABLE "agent_mandates" ADD COLUMN "fund_total_cap_minor" bigint;--> statement-breakpoint
ALTER TABLE "agent_mandates" ADD COLUMN "auto_fund_next" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_setups" ADD CONSTRAINT "vault_setups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_paypal_payment_token_id" ON "payment_methods" USING btree ("paypal_payment_token_id");--> statement-breakpoint
CREATE INDEX "payment_methods_user" ON "payment_methods" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_setups_setup_token_id" ON "vault_setups" USING btree ("setup_token_id");--> statement-breakpoint
CREATE INDEX "vault_setups_user" ON "vault_setups" USING btree ("user_id");