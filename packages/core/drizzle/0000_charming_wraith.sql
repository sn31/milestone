CREATE TYPE "public"."advance_status" AS ENUM('offered', 'funded', 'repaid', 'shortfall');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'approved', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."criterion_kind" AS ENUM('test', 'build', 'file', 'visual', 'judgment');--> statement-breakpoint
CREATE TYPE "public"."delivery_source" AS ENUM('github_pr', 'deploy_url', 'manual');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('draft', 'funded', 'verifying', 'review', 'released', 'held', 'needs_client', 'partial_released');--> statement-breakpoint
CREATE TYPE "public"."op_status" AS ENUM('pending', 'sent', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('client', 'freelancer', 'partner', 'platform');--> statement-breakpoint
CREATE TYPE "public"."verdict_result" AS ENUM('pass', 'partial', 'fail');--> statement-breakpoint
CREATE TABLE "advances" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"principal_minor" bigint NOT NULL,
	"fee_bps_per_day" integer NOT NULL,
	"status" "advance_status" DEFAULT 'offered' NOT NULL,
	"offer" jsonb NOT NULL,
	"explanation" text,
	"funded_at" timestamp with time zone,
	"repaid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text,
	"milestone_id" text,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"freelancer_id" text NOT NULL,
	"title" text NOT NULL,
	"scope_text" text NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"per_release_cap_minor" bigint,
	"confidence_threshold_pct" integer DEFAULT 80 NOT NULL,
	"review_window_seconds" integer DEFAULT 172800 NOT NULL,
	"repo_full_name" text,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"client_approved_at" timestamp with time zone,
	"freelancer_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "criteria" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"kind" "criterion_kind" NOT NULL,
	"description" text NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"source" "delivery_source" NOT NULL,
	"ref" text NOT NULL,
	"payload" jsonb,
	"evidence" jsonb,
	"verdict" jsonb,
	"result" "verdict_result",
	"suspected_injection" boolean DEFAULT false NOT NULL,
	"model" text,
	"prompt_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"txn_id" text NOT NULL,
	"account" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"due_at" timestamp with time zone,
	"status" "milestone_status" DEFAULT 'draft' NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"decision" jsonb,
	"decided_at" timestamp with time zone,
	"review_ends_at" timestamp with time zone,
	"client_response" text,
	"advance_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_ops" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"request_id" text NOT NULL,
	"paypal_id" text,
	"status" "op_status" DEFAULT 'pending' NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"role" "user_role" NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"paypal_email" text,
	"github_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_partner_id_users_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_freelancer_id_users_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_txn" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "ledger_account" ON "ledger_entries" USING btree ("account");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_contract_seq" ON "milestones" USING btree ("contract_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_ops_request_id" ON "paypal_ops" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_ops_kind_key" ON "paypal_ops" USING btree ("kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_event" ON "webhook_events" USING btree ("source","event_id");