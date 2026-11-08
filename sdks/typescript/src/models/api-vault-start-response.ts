import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiVaultStartResponse = {
  setupTokenId: string;
  approveUrl: string;
};

export const apiVaultStartResponseSchema: Schema<ApiVaultStartResponse> = s.object<ApiVaultStartResponse>({
  setupTokenId: s.string(),
  approveUrl: s.string(),
});
