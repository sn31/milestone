import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiAgentsConsoleRequest = {
  mandateId: string;
  token: string;
  /** Ends with the client's message */
  messages: Record<string, unknown>[];
};

export const apiAgentsConsoleRequestSchema: Schema<ApiAgentsConsoleRequest> =
  s.object<ApiAgentsConsoleRequest>({
    mandateId: s.string(),
    token: s.string(),
    messages: s.array(s.record(s.string(), s.unknown())),
  });
