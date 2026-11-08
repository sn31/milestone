ALTER TABLE "contracts" ADD COLUMN "aup_status" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "aup_text_hash" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "aup_check" jsonb;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "aup_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contracts_aup_status" ON "contracts" USING btree ("aup_status");