import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  advanceAcceptResponseSchema,
  type AdvanceAcceptResponse,
} from "../models/advance-accept-response.js";
import { advanceOfferResponseSchema, type AdvanceOfferResponse } from "../models/advance-offer-response.js";
import {
  apiAdvancesAcceptRequestSchema,
  type ApiAdvancesAcceptRequest,
} from "../models/api-advances-accept-request.js";
import {
  apiAdvancesAccept409Error1Schema,
  type ApiAdvancesAccept409Error1,
} from "../models/api-advances-accept409-error1.js";
import { errorSchema, type Error } from "../models/error.js";
import type { Servers } from "../servers.js";

export class Advances {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Accept the advance offer
   *
   * @remarks
   * The contract's freelancer only. Under row locks the offer is re-priced from the database and
   * stored as an advance with status `offered`, `advance.accepted` is audited, and the `advance`
   * job is queued; the job pays the principal from the capital partner's PayPal account. One
   * advance per milestone: a second call returns the existing advance with 200 and `created:
   * false`. The release repays the partner first (principal plus the quoted fee) and pays the
   * freelancer the rest.
   *
   * @returns An advance already existed
   *
   * @throws {@link Advances.AcceptAdvanceError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  acceptAdvance(
    request: Advances.AcceptAdvanceRequest,
    options?: RequestOptions,
  ): ApiPromise<AdvanceAcceptResponse, Advances.AcceptAdvanceError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/advances/accept"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiAdvancesAcceptRequestSchema },
      },
      {
        success: { kind: "json", schema: advanceAcceptResponseSchema },
        errorFactory: Advances.AcceptAdvanceError,
      },
      options,
    );
  }

  /**
   * Price an advance against a funded milestone
   *
   * @remarks
   * The contract's freelancer only. If the milestone already has an advance (one per milestone) it
   * is returned with its stored offer. Otherwise a fresh offer is priced from the database; an
   * ineligible milestone answers 200 with `offer.eligible: false` and a reason. The explanation is
   * two sentences from Claude when ANTHROPIC_API_KEY is set, otherwise built from the numbers. The
   * model never changes the numbers.
   *
   * @returns Offer or existing advance
   *
   * @throws {@link Advances.GetAdvanceOfferError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getAdvanceOffer(
    request: Advances.GetAdvanceOfferRequest,
    options?: RequestOptions,
  ): ApiPromise<AdvanceOfferResponse, Advances.GetAdvanceOfferError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/advances/offer"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [{ name: "milestoneId", value: request.milestoneId, schema: s.string() }],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: advanceOfferResponseSchema },
        errorFactory: Advances.GetAdvanceOfferError,
      },
      options,
    );
  }
}

export namespace Advances {
  export type AcceptAdvanceRequest = {
    body: ApiAdvancesAcceptRequest;
  };

  export class AcceptAdvanceError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"apiAdvancesAccept409Error1", ApiAdvancesAccept409Error1>
      | Declared<"error4", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<AcceptAdvanceError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      {
        on: 409,
        kind: "apiAdvancesAccept409Error1",
        decode: { kind: "json", schema: apiAdvancesAccept409Error1Schema },
      },
      { on: 503, kind: "error4", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type GetAdvanceOfferRequest = {
    milestoneId: string;
  };

  export class GetAdvanceOfferError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<GetAdvanceOfferError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
