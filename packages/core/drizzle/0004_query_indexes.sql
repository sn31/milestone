CREATE INDEX "advances_milestone" ON "advances" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "audit_milestone_created" ON "audit_log" USING btree ("milestone_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_contract_created" ON "audit_log" USING btree ("contract_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_milestone" ON "audit_log" USING btree ("event","milestone_id");--> statement-breakpoint
CREATE INDEX "criteria_milestone" ON "criteria" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "deliveries_milestone_received" ON "deliveries" USING btree ("milestone_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "milestones_paypal_capture_id" ON "milestones" USING btree ("paypal_capture_id");--> statement-breakpoint
CREATE INDEX "milestones_paypal_order_id" ON "milestones" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE INDEX "paypal_ops_key" ON "paypal_ops" USING btree ("key");