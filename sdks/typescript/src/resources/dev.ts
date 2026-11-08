import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiDevPaypalFailResponseSchema,
  type ApiDevPaypalFailResponse,
} from "../models/api-dev-paypal-fail-response.js";
import {
  apiDevPaypalFailResponse1Schema,
  type ApiDevPaypalFailResponse1,
} from "../models/api-dev-paypal-fail-response1.js";
import {
  apiDevPaypalModeResponseSchema,
  type ApiDevPaypalModeResponse,
} from "../models/api-dev-paypal-mode-response.js";
import {
  apiDisputesDevRequestSchema,
  type ApiDisputesDevRequest,
} from "../models/api-disputes-dev-request.js";
import { errorSchema, type Error } from "../models/error.js";
import { Party, partySchema } from "../models/party.js";
import type { Servers } from "../servers.js";

export class Dev {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * Simulated PayPal checkout page
   *
   * @remarks
   * Exists only while PAYPAL_MODE is simulated (404 otherwise). The approve link of a simulated
   * order points here. It marks the order APPROVED and redirects (303) to
   * /contracts/{contractId}?approved=<orderId>&milestone=<id>, where the fund button captures it.
   *
   * @throws {@link Dev.ApproveSimulatedOrderError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  approveSimulatedOrder(
    request: Dev.ApproveSimulatedOrderRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Dev.ApproveSimulatedOrderError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/dev/paypal/approve"),
        auth: noneAuth,
        pathParams: [],
        query: [{ name: "order", value: request.order, schema: s.string() }],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Dev.ApproveSimulatedOrderError,
      },
      options,
    );
  }

  /**
   * Simulated PayPal approval page for saving a PayPal
   *
   * @remarks
   * Exists only while PAYPAL_MODE is simulated (404 otherwise). Marks the setup token approved and
   * redirects to its return_url (only one on this app) with ?approval_token_id=<id>.
   *
   * @throws {@link Dev.ApproveSimulatedVaultSetupError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  approveSimulatedVaultSetup(
    request: Dev.ApproveSimulatedVaultSetupRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Dev.ApproveSimulatedVaultSetupError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/dev/paypal/vault-approve"),
        auth: noneAuth,
        pathParams: [],
        query: [{ name: "token", value: request.token, schema: s.string() }],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Dev.ApproveSimulatedVaultSetupError,
      },
      options,
    );
  }

  /**
   * Make the next simulated payout item fail
   *
   * @remarks
   * Exists only while PAYPAL_MODE is simulated (404 otherwise). Arms a one-shot failure: the next
   * payout item with this sender_item_id comes back FAILED, so the release goes to `held` with
   * `milestone.needs_operator`. Release items use `<milestoneId>:freelancer` and
   * `<milestoneId>:partner`. Accepts JSON, or a form post (the /ops "Simulate payout failure"
   * button).
   *
   * @returns Armed
   *
   * @throws {@link Dev.ArmSimulatedPayoutFailureError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  armSimulatedPayoutFailure(
    request: Dev.ArmSimulatedPayoutFailureRequest = {},
    options?: RequestOptions,
  ): ApiPromise<ApiDevPaypalFailResponse, Dev.ArmSimulatedPayoutFailureError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/dev/paypal/fail"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: {
          kind: "formUrlEncoded",
          value: [
            { name: "sender_item_id", value: request.senderItemId, schema: s.optional(s.string()) },
            { name: "milestoneId", value: request.milestoneId, schema: s.optional(s.string()) },
            { name: "party", value: request.party, schema: s.defaulted(partySchema, Party.Freelancer) },
            {
              name: "reason",
              value: request.reason,
              schema: s.defaulted(s.string(), "RECEIVER_ACCOUNT_LOCKED"),
            },
          ],
        },
      },
      {
        success: { kind: "json", schema: apiDevPaypalFailResponseSchema },
        errorFactory: Dev.ArmSimulatedPayoutFailureError,
      },
      options,
    );
  }

  /**
   * Which PayPal the server talks to
   *
   * @remarks
   * Answers in every mode. The fund button asks when it was not told.
   *
   * @returns Mode
   *
   * @throws {@link ApiError} when the API answers with an error status
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getPayPalMode(options?: RequestOptions): ApiPromise<ApiDevPaypalModeResponse, ApiError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/dev/paypal/mode"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: apiDevPaypalModeResponseSchema },
        errorFactory: ApiError,
      },
      options,
    );
  }

  /**
   * List armed simulated payout failures
   *
   * @remarks
   * Simulated PayPal only. Lists the payout failures armed for the next payouts, used to
   * demonstrate a held release.
   *
   * @returns Armed failures
   *
   * @throws {@link Dev.ListArmedFailuresError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  listArmedFailures(
    options?: RequestOptions,
  ): ApiPromise<ApiDevPaypalFailResponse1, Dev.ListArmedFailuresError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/dev/paypal/fail"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: apiDevPaypalFailResponse1Schema },
        errorFactory: Dev.ListArmedFailuresError,
      },
      options,
    );
  }

  /**
   * Have the simulated buyer open a dispute against a milestone's capture
   *
   * @remarks
   * Simulated PayPal only. The simulator then sends CUSTOMER.DISPUTE.CREATED to the PayPal webhook.
   * JSON or form body.
   *
   * @returns The simulated dispute, with milestoneId
   *
   * @throws {@link Dev.OpenSimulatedDisputeError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  openSimulatedDispute(
    request: Dev.OpenSimulatedDisputeRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Dev.OpenSimulatedDisputeError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/disputes/dev"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiDisputesDevRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Dev.OpenSimulatedDisputeError,
      },
      options,
    );
  }
}

export namespace Dev {
  export type ApproveSimulatedOrderRequest = {
    order: string;
  };

  export class ApproveSimulatedOrderError extends ApiError {
    declare readonly payload:
      | Declared<"error303", undefined>
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<ApproveSimulatedOrderError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error3", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type ApproveSimulatedVaultSetupRequest = {
    token: string;
  };

  export class ApproveSimulatedVaultSetupError extends ApiError {
    declare readonly payload:
      | Declared<"error303", undefined>
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<ApproveSimulatedVaultSetupError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error3", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type ArmSimulatedPayoutFailureRequest = {
    senderItemId?: string;
    milestoneId?: string;
    /** @default Party.Freelancer */
    party?: Party;
    /** A PayPal error name @default "RECEIVER_ACCOUNT_LOCKED" */
    reason?: string;
  };

  export class ArmSimulatedPayoutFailureError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Declared<"error2", Error> | Undeclared;

    static readonly errors: ErrorDecoders<ArmSimulatedPayoutFailureError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export class ListArmedFailuresError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<ListArmedFailuresError> = [
      { on: 404, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type OpenSimulatedDisputeRequest = {
    body: ApiDisputesDevRequest;
  };

  export class OpenSimulatedDisputeError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<OpenSimulatedDisputeError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error3", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
