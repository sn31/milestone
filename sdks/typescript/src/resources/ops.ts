import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import { apiOpsAupRequestSchema, type ApiOpsAupRequest } from "../models/api-ops-aup-request.js";
import { apiOpsAupResponseSchema, type ApiOpsAupResponse } from "../models/api-ops-aup-response.js";
import { apiOpsResolveRequestSchema, type ApiOpsResolveRequest } from "../models/api-ops-resolve-request.js";
import {
  apiOpsResolveResponseSchema,
  type ApiOpsResolveResponse,
} from "../models/api-ops-resolve-response.js";
import { errorSchema, type Error } from "../models/error.js";
import type { Servers } from "../servers.js";

export class Ops {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Queue a reconciliation against PayPal's transactions
   *
   * @remarks
   * Partner or platform only; agents (any Authorization header) are refused. Queues the worker's
   * reconcile job, which reads list_transactions through PayPal's MCP server (read-only). A repeat
   * inside the same minute is a no-op.
   *
   * @returns { ok, queued: reconcile, jobId }
   *
   * @throws {@link Ops.ReconcileNowError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  reconcileNow(options?: RequestOptions): ApiPromise<undefined, Ops.ReconcileNowError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/ops/reconcile"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Ops.ReconcileNowError,
      },
      options,
    );
  }

  /**
   * Clear or reject a contract the PayPal AUP check flagged
   *
   * @remarks
   * Partner or platform role only, and only while the contract's PayPal Acceptable Use Policy check
   * is in review. clear moves it to cleared (it can be signed and funded as usual; aup.cleared).
   * reject is final (aup.rejected). Moves no money.
   *
   * @returns Recorded
   *
   * @throws {@link Ops.ResolveAupReviewError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  resolveAupReview(
    request: Ops.ResolveAupReviewRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiOpsAupResponse, Ops.ResolveAupReviewError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/ops/aup/{contractId}"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "contractId", value: request.contractId, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiOpsAupRequestSchema },
      },
      {
        success: { kind: "json", schema: apiOpsAupResponseSchema },
        errorFactory: Ops.ResolveAupReviewError,
      },
      options,
    );
  }

  /**
   * Record that an operator resolved a flagged milestone
   *
   * @remarks
   * Partner or platform role only. Requires the latest operator event for the milestone to be
   * milestone.needs_operator. Writes an ops.resolved audit entry; it does not move money or change
   * the status.
   *
   * @returns Recorded
   *
   * @throws {@link Ops.ResolveOperatorCaseError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  resolveOperatorCase(
    request: Ops.ResolveOperatorCaseRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiOpsResolveResponse, Ops.ResolveOperatorCaseError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/ops/{milestoneId}/resolve"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "milestoneId", value: request.milestoneId, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiOpsResolveRequestSchema },
      },
      {
        success: { kind: "json", schema: apiOpsResolveResponseSchema },
        errorFactory: Ops.ResolveOperatorCaseError,
      },
      options,
    );
  }
}

export namespace Ops {
  export class ReconcileNowError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Declared<"error2", Error> | Undeclared;

    static readonly errors: ErrorDecoders<ReconcileNowError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 503, kind: "error2", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type ResolveAupReviewRequest = {
    contractId: string;
    body: ApiOpsAupRequest;
  };

  export class ResolveAupReviewError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error409", undefined>
      | Undeclared;

    static readonly errors: ErrorDecoders<ResolveAupReviewError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error409", decode: { kind: "empty" } },
    ];
  }

  export type ResolveOperatorCaseRequest = {
    milestoneId: string;
    body: ApiOpsResolveRequest;
  };

  export class ResolveOperatorCaseError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<ResolveOperatorCaseError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
