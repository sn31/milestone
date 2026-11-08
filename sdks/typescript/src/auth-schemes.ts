import type { ClientOptions } from "./client-options.js";
import type { AuthScheme } from "./core/api-request.js";
import { apiKeyCookieAuth, bearerAuth } from "./core/auth/schemes.js";

export type AuthSchemes = {
  readonly roleCookie: AuthScheme;
  readonly mandateToken: AuthScheme;
};

export function buildAuthSchemes(options: ClientOptions): AuthSchemes {
  return {
    roleCookie: apiKeyCookieAuth({ name: "milestone_actor", token: options.roleCookie }),
    mandateToken: bearerAuth(options.mandateToken),
  };
}
