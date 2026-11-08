import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import {
  apiPaypalClientTokenResponseSchema,
  type ApiPaypalClientTokenResponse,
} from "../models/api-paypal-client-token-response.js";
import type { Servers } from "../servers.js";

export class Paypal {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Browser token for PayPal JS SDK v6
   *
   * @remarks
   * Returns a short-lived token the browser passes to the PayPal JS SDK v6 to render the PayPal
   * button.
   *
   * @returns Short-lived token
   *
   * @throws {@link ApiError} when the API answers with an error status
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getClientToken(options?: RequestOptions): ApiPromise<ApiPaypalClientTokenResponse, ApiError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/paypal/client-token"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: apiPaypalClientTokenResponseSchema },
        errorFactory: ApiError,
      },
      options,
    );
  }
}
