import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type CreateMandateRequest = {
  agentName: string;
  /** Mandate actions the caller's role may delegate, for example read, fund, approve, hold */
  actions: string[];
  /** @default "USD" */
  currency?: string;
  /** Major units; required when actions include approve */
  approveCap?: string;
  approveCapMinor?: number;
  /** Per milestone; set with fundTotalCap or neither */
  fundCap?: string;
  fundCapMinor?: number;
  /** Over the mandate's life */
  fundTotalCap?: string;
  fundTotalCapMinor?: number;
  /** Fund the next milestone after each release; needs fund and both caps @default false */
  autoFundNext?: boolean;
  /** @default 30 */
  expiresInDays?: number;
  expiresAt?: Date;
};

export const createMandateRequestSchema: Schema<CreateMandateRequest> = s.object<CreateMandateRequest>({
  agentName: s.string(),
  actions: s.array(s.string()),
  currency: s.defaulted(s.string(), "USD"),
  approveCap: s.optional(s.string()),
  approveCapMinor: s.optional(s.int()),
  fundCap: s.optional(s.string()),
  fundCapMinor: s.optional(s.int()),
  fundTotalCap: s.optional(s.string()),
  fundTotalCapMinor: s.optional(s.int()),
  autoFundNext: s.defaulted(s.boolean(), false),
  expiresInDays: s.defaulted(s.int(), 30),
  expiresAt: s.optional(s.dateTime()),
});
