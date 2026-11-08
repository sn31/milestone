import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiVaultStartResponseSchema,
  type ApiVaultStartResponse,
} from "../models/api-vault-start-response.js";
import { errorSchema, type Error } from "../models/error.js";
import { payPalError1Schema, type PayPalError1 } from "../models/pay-pal-error1.js";
import type { Servers } from "../servers.js";

export class Vault {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Get the saved PayPal
   *
   * @remarks
   * The signed-in client's saved PayPal, or paymentMethod null when none is saved. Clients only;
   * agents are refused.
   *
   * @returns { paymentMethod }
   *
   * @throws {@link Vault.GetSavedPayPalError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getSavedPayPal(options?: RequestOptions): ApiPromise<undefined, Vault.GetSavedPayPalError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/vault"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Vault.GetSavedPayPalError,
      },
      options,
    );
  }

  /**
   * Remove the saved PayPal (marked removed first, then deleted at PayPal)
   *
   * @remarks
   * Clients only. { paymentMethodId } in the body or ?id=, else the current one. Idempotent.
   *
   * @returns { ok, paymentMethod }
   *
   * @throws {@link Vault.RemoveSavedPayPalError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  removeSavedPayPal(
    request: Vault.RemoveSavedPayPalRequest = {},
    options?: RequestOptions,
  ): ApiPromise<undefined, Vault.RemoveSavedPayPalError> {
    return this.#rawClient.execute(
      {
        method: "DELETE",
        urlTemplate: this.#servers.default("/api/vault"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [{ name: "id", value: request.id, schema: s.optional(s.string()) }],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Vault.RemoveSavedPayPalError,
      },
      options,
    );
  }

  /**
   * PayPal's return URL after the payer approves; exchanges the setup token for a payment token
   *
   * @remarks
   * The setup token must belong to the signed-in user. Redirects to /agents?vault=<outcome>.
   *
   * @throws {@link Vault.ReturnFromSavePayPalError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  returnFromSavePayPal(
    request: Vault.ReturnFromSavePayPalRequest = {},
    options?: RequestOptions,
  ): ApiPromise<undefined, Vault.ReturnFromSavePayPalError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/vault/return"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [
          { name: "approval_token_id", value: request.approvalTokenId, schema: s.optional(s.string()) },
          { name: "cancelled", value: request.cancelled, schema: s.optional(s.string()) },
        ],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Vault.ReturnFromSavePayPalError,
      },
      options,
    );
  }

  /**
   * Start saving a PayPal (Payment Method Tokens v3 setup token); nothing is charged
   *
   * @remarks
   * Clients only; agents are refused. One saved PayPal at a time (409 already_saved). The browser
   * goes to approveUrl.
   *
   * @returns Setup token created
   *
   * @throws {@link Vault.StartSavePayPalError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  startSavePayPal(options?: RequestOptions): ApiPromise<ApiVaultStartResponse, Vault.StartSavePayPalError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/vault/start"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: apiVaultStartResponseSchema },
        errorFactory: Vault.StartSavePayPalError,
      },
      options,
    );
  }
}

export namespace Vault {
  export class GetSavedPayPalError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<GetSavedPayPalError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type RemoveSavedPayPalRequest = {
    id?: string;
  };

  export class RemoveSavedPayPalError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<RemoveSavedPayPalError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }

  export type ReturnFromSavePayPalRequest = {
    approvalTokenId?: string;
    /** Set to 1 when the payer cancelled the approval */
    cancelled?: string;
  };

  export class ReturnFromSavePayPalError extends ApiError {
    declare readonly payload: Declared<"error303", undefined> | Undeclared;

    static readonly errors: ErrorDecoders<ReturnFromSavePayPalError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
    ];
  }

  export class StartSavePayPalError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<StartSavePayPalError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }
}
