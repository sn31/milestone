import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { anyAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiMilestonesCaptureRequestSchema,
  type ApiMilestonesCaptureRequest,
} from "../models/api-milestones-capture-request.js";
import {
  apiMilestonesOrderResponseSchema,
  type ApiMilestonesOrderResponse,
} from "../models/api-milestones-order-response.js";
import {
  apiMilestonesReviewRequestSchema,
  type ApiMilestonesReviewRequest,
} from "../models/api-milestones-review-request.js";
import {
  apiMilestonesReview409Error1Schema,
  type ApiMilestonesReview409Error1,
} from "../models/api-milestones-review409-error1.js";
import { captureResultSchema, type CaptureResult } from "../models/capture-result.js";
import { errorSchema, type Error } from "../models/error.js";
import { payPalError1Schema, type PayPalError1 } from "../models/pay-pal-error1.js";
import {
  apiMilestonesReviewResponse2Schema,
  type ApiMilestonesReviewResponse2,
} from "../models/unions/api-milestones-review-response2.js";
import type { Servers } from "../servers.js";

export class Milestones {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Capture the approved order and fund the milestone
   *
   * @remarks
   * Client only. Idempotent; a milestone already past draft returns its current status.
   *
   * @returns Funded, or already past draft
   *
   * @throws {@link Milestones.CaptureFundingError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  captureFunding(
    request: Milestones.CaptureFundingRequest,
    options?: RequestOptions,
  ): ApiPromise<CaptureResult, Milestones.CaptureFundingError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/milestones/{id}/capture"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiMilestonesCaptureRequestSchema },
      },
      {
        success: { kind: "json", schema: captureResultSchema },
        errorFactory: Milestones.CaptureFundingError,
      },
      options,
    );
  }

  /**
   * Create or replay the PayPal order that funds a milestone
   *
   * @remarks
   * Client only. The contract must be active and the milestone in draft. Repeated calls return the
   * same order. Refused with 409 and reason aup_unchecked, aup_checking, aup_review or aup_rejected
   * while the contract's PayPal Acceptable Use Policy check is not clear, keywords_only or cleared
   * (no order is created; audited as aup.refused).
   *
   * @returns Order created
   *
   * @throws {@link Milestones.CreateFundingOrderError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  createFundingOrder(
    request: Milestones.CreateFundingOrderRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiMilestonesOrderResponse, Milestones.CreateFundingOrderError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/milestones/{id}/order"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: apiMilestonesOrderResponseSchema },
        errorFactory: Milestones.CreateFundingOrderError,
      },
      options,
    );
  }

  /**
   * Live snapshot of one milestone (status, decision, latest verification, newest audit row)
   *
   * @remarks
   * Read only. The contract page polls it while a milestone is live.
   *
   * @returns Snapshot
   *
   * @throws {@link Milestones.GetMilestoneStatusError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getMilestoneStatus(
    request: Milestones.GetMilestoneStatusRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Milestones.GetMilestoneStatusError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/milestones/{id}/status"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Milestones.GetMilestoneStatusError,
      },
      options,
    );
  }

  /**
   * Snapshots of several milestones at once
   *
   * @remarks
   * Read only. Sends an ETag; a poll with a matching If-None-Match gets 304. Unknown ids are left
   * out.
   *
   * @returns Snapshots of the milestones that exist
   *
   * @throws {@link Milestones.GetMilestoneStatusesError} when the API answers with an error status
   * — narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getMilestoneStatuses(
    request: Milestones.GetMilestoneStatusesRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Milestones.GetMilestoneStatusesError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/milestones/status"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [{ name: "ids", value: request.ids, schema: s.string() }],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Milestones.GetMilestoneStatusesError,
      },
      options,
    );
  }

  /**
   * Client response during the review window or on a needs_client decision
   *
   * @remarks
   * Client only. approve (from review or needs_client) and confirm_partial (from needs_client)
   * queue the release job. veto (from review) and hold (from needs_client) move the milestone to
   * held. Refused once the payout has been claimed, after the window closed (veto and hold), or
   * when a required criterion did not pass.
   *
   * An agent may call it with a mandate token. Its approve is accepted only while the milestone is
   * in review on the policy's own release decision (P6) for the latest delivery, every required
   * criterion passed and the amount is within the mandate's cap; veto and hold need "hold" in the
   * mandate; confirm_partial is never an agent's. Accepted and refused agent calls are audited.
   *
   * @returns Accepted
   *
   * @throws {@link Milestones.ReviewMilestoneError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  reviewMilestone(
    request: Milestones.ReviewMilestoneRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiMilestonesReviewResponse2, Milestones.ReviewMilestoneError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/milestones/{id}/review"),
        auth: anyAuth(this.#auth.roleCookie, this.#auth.mandateToken),
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiMilestonesReviewRequestSchema },
      },
      {
        success: { kind: "json", schema: apiMilestonesReviewResponse2Schema },
        errorFactory: Milestones.ReviewMilestoneError,
      },
      options,
    );
  }
}

export namespace Milestones {
  export type CaptureFundingRequest = {
    id: string;
    body: ApiMilestonesCaptureRequest;
  };

  export class CaptureFundingError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<CaptureFundingError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }

  export type CreateFundingOrderRequest = {
    id: string;
  };

  export class CreateFundingOrderError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"payPalError1", PayPalError1>
      | Undeclared;

    static readonly errors: ErrorDecoders<CreateFundingOrderError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 502, kind: "payPalError1", decode: { kind: "json", schema: payPalError1Schema } },
    ];
  }

  export type GetMilestoneStatusRequest = {
    id: string;
  };

  export class GetMilestoneStatusError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<GetMilestoneStatusError> = [
      { on: 404, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type GetMilestoneStatusesRequest = {
    ids: string;
  };

  export class GetMilestoneStatusesError extends ApiError {
    declare readonly payload: Declared<"error304", undefined> | Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<GetMilestoneStatusesError> = [
      { on: 304, kind: "error304", decode: { kind: "empty" } },
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type ReviewMilestoneRequest = {
    id: string;
    body: ApiMilestonesReviewRequest;
  };

  export class ReviewMilestoneError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Declared<"apiMilestonesReview409Error1", ApiMilestonesReview409Error1>
      | Undeclared;

    static readonly errors: ErrorDecoders<ReviewMilestoneError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 401, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error4", decode: { kind: "json", schema: errorSchema } },
      {
        on: 409,
        kind: "apiMilestonesReview409Error1",
        decode: { kind: "json", schema: apiMilestonesReview409Error1Schema },
      },
    ];
  }
}
