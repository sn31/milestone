import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiDisputesAcceptRequestSchema,
  type ApiDisputesAcceptRequest,
} from "../models/api-disputes-accept-request.js";
import {
  apiDisputesSubmitRequestSchema,
  type ApiDisputesSubmitRequest,
} from "../models/api-disputes-submit-request.js";
import { errorSchema, type Error } from "../models/error.js";
import { payPalError1Schema, type PayPalError1 } from "../models/pay-pal-error1.js";
import type { Servers } from "../servers.js";

export class Disputes {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Accept the buyer's claim (PayPal refunds the buyer)
   *
   * @remarks
   * The contract's freelancer only, and only once the milestone's money left escrow (else 409
   * milestone_not_final). Without `confirm: true` nothing is sent. The refund moves through
   * execute.ts, which books it in the ledger.
   *
   * @returns { ok, requestId }
   *
   * @throws {@link Disputes.AcceptDisputeClaimError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  acceptDisputeClaim(
    request: Disputes.AcceptDisputeClaimRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Disputes.AcceptDisputeClaimError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/disputes/{id}/accept"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiDisputesAcceptRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Disputes.AcceptDisputeClaimError,
      },
      options,
    );
  }

  /**
   * Send the freelancer's dispute response to PayPal (provide-evidence)
   *
   * @remarks
   * The contract's freelancer only. The delivered files go as documents when PayPal takes them. A
   * double submit is answered once.
   *
   * @returns { ok, requestId, attached, skipped }
   *
   * @throws {@link Disputes.SubmitDisputeEvidenceError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  submitDisputeEvidence(
    request: Disputes.SubmitDisputeEvidenceRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Disputes.SubmitDisputeEvidenceError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/disputes/{id}/submit"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiDisputesSubmitRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Disputes.SubmitDisputeEvidenceError,
      },
      options,
    );
  }
}

export namespace Disputes {
  export type AcceptDisputeClaimRequest = {
    /** Dispute id */
    id: string;
    body: ApiDisputesAcceptRequest;
  };

  export class AcceptDisputeClaimError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<AcceptDisputeClaimError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }

  export type SubmitDisputeEvidenceRequest = {
    /** Dispute id */
    id: string;
    body: ApiDisputesSubmitRequest;
  };

  export class SubmitDisputeEvidenceError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<SubmitDisputeEvidenceError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }
}
