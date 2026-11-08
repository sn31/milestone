import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ManualDeliveryRequest = {
  /**
   * https URL, file:// URL or absolute local path; ssh, git:// and credentials in the URL are
   * refused
   */
  repoUrl: string;
  /** Branch, tag, HEAD or a 40-character commit id @default "HEAD" */
  ref?: string;
  title?: string;
  note?: string;
};

export const manualDeliveryRequestSchema: Schema<ManualDeliveryRequest> = s.object<ManualDeliveryRequest>({
  repoUrl: s.string(),
  ref: s.defaulted(s.string(), "HEAD"),
  title: s.optional(s.string()),
  note: s.optional(s.string()),
});
