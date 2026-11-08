import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiPaypalClientTokenResponse = {
  accessToken: string;
  /** Seconds */
  expiresIn: number;
};

export const apiPaypalClientTokenResponseSchema: Schema<ApiPaypalClientTokenResponse> =
  s.object<ApiPaypalClientTokenResponse>({
    accessToken: s.string(),
    expiresIn: s.int(),
  });
