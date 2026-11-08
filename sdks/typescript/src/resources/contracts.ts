import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiContractsCriteriaRequestSchema,
  type ApiContractsCriteriaRequest,
} from "../models/api-contracts-criteria-request.js";
import { errorSchema, type Error } from "../models/error.js";
import type { Servers } from "../servers.js";

export class Contracts {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Approve a contract as the client or the freelancer
   *
   * @remarks
   * Records the caller's approval time. When both have approved, the contract becomes active.
   * Neither party can approve while the contract's PayPal Acceptable Use Policy check is not clear,
   * keywords_only or cleared by an operator: 409 with reason aup_unchecked, aup_checking,
   * aup_review or aup_rejected (audited as aup.refused). A browser form post (Accept text/html) is
   * redirected to /contracts/{id}?aup=<reason> instead.
   *
   * @throws {@link Contracts.ApproveContractError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  approveContract(
    request: Contracts.ApproveContractRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Contracts.ApproveContractError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/contracts/{id}/approve"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Contracts.ApproveContractError,
      },
      options,
    );
  }

  /**
   * Compile a scope into a draft contract
   *
   * @remarks
   * Form post from the New contract page. With ANTHROPIC_API_KEY set, Claude compiles the scope;
   * otherwise a three-milestone demo contract is built. Responds with a 303 redirect to the
   * contract page. The new contract's PayPal Acceptable Use Policy check starts here: without a
   * model the keyword pass is stored at once (keywords_only, or review on a hit); with one the
   * contract is "checking" until the worker's aup job stores the result.
   *
   * @throws {@link Contracts.CreateContractError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  createContract(
    request: Contracts.CreateContractRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Contracts.CreateContractError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/contracts"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: {
          kind: "formUrlEncoded",
          value: [
            { name: "scope", value: request.scope, schema: s.string() },
            { name: "total", value: request.total, schema: s.float64() },
            { name: "title", value: request.title, schema: s.optional(s.string()) },
            { name: "currency", value: request.currency, schema: s.defaulted(s.string(), "USD") },
            { name: "repo", value: request.repo, schema: s.optional(s.string()) },
          ],
        },
      },
      {
        success: { kind: "empty" },
        errorFactory: Contracts.CreateContractError,
      },
      options,
    );
  }

  /**
   * Edit one milestone's release conditions while the contract is a draft
   *
   * @remarks
   * Either party. Body: { milestoneId, operations: [{ op: add | remove | update | reorder, ... }]
   * }. Validated with the compiler's rules and audited before and after; an edit after one party
   * approved clears both approvals. An edit that changes the criteria starts a new PayPal
   * Acceptable Use Policy check of the contract text. With DEMO_MODE=1, test and build commands are
   * limited to npm test and npm run <script>, with no options or shell characters.
   *
   * @returns { ok, milestoneId, criteria, approvalsCleared, changed }
   *
   * @throws {@link Contracts.EditCriteriaError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  editCriteria(
    request: Contracts.EditCriteriaRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Contracts.EditCriteriaError> {
    return this.#rawClient.execute(
      {
        method: "PATCH",
        urlTemplate: this.#servers.default("/api/contracts/{id}/criteria"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiContractsCriteriaRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Contracts.EditCriteriaError,
      },
      options,
    );
  }
}

export namespace Contracts {
  export type ApproveContractRequest = {
    id: string;
  };

  export class ApproveContractError extends ApiError {
    declare readonly payload:
      | Declared<"error303", undefined>
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<ApproveContractError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
      { on: 409, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type CreateContractRequest = {
    /** Plain-English scope */
    scope: string;
    /** Total in major units, for example 300.00 */
    total: number;
    /** Optional; defaults to the compiled title */
    title?: string;
    /** @default "USD" */
    currency?: string;
    /** owner/name of the delivery repository */
    repo?: string;
  };

  export class CreateContractError extends ApiError {
    declare readonly payload: Declared<"error303", undefined> | Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<CreateContractError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
      { on: 502, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type EditCriteriaRequest = {
    id: string;
    body: ApiContractsCriteriaRequest;
  };

  export class EditCriteriaError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error409", undefined>
      | Declared<"error422", undefined>
      | Undeclared;

    static readonly errors: ErrorDecoders<EditCriteriaError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error409", decode: { kind: "empty" } },
      { on: 422, kind: "error422", decode: { kind: "empty" } },
    ];
  }
}
