import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type PayPalWebhookEvent = {
  id: string;
  eventType: string;
  createTime: string;
  resourceType?: string;
  resource?: Record<string, unknown>;
};

export const payPalWebhookEventSchema: Schema<PayPalWebhookEvent> = s.object<PayPalWebhookEvent>({
  id: s.string(),
  eventType: s.string(),
  createTime: s.string(),
  resourceType: s.optional(s.string()),
  resource: s.optional(s.record(s.string(), s.unknown())),
  _keysMap: {
    eventType: "event_type",
    createTime: "create_time",
    resourceType: "resource_type",
  },
});
