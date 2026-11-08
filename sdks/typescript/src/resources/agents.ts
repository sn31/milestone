import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiAgentsConsoleRequestSchema,
  type ApiAgentsConsoleRequest,
} from "../models/api-agents-console-request.js";
import { apiAgentsRequestSchema, type ApiAgentsRequest } from "../models/api-agents-request.js";
import { createMandateRequestSchema, type CreateMandateRequest } from "../models/create-mandate-request.js";
import { errorSchema, type Error } from "../models/error.js";
import type { Servers } from "../servers.js";

export class Agents {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * One turn of the built-in agent console, streamed as NDJSON
   *
   * @remarks
   * The signed-in client names one of their mandates and supplies its token; the server runs Claude
   * as an MCP client of /api/mcp under that token (and of PayPal's MCP server, list_transactions
   * only). Needs ANTHROPIC_API_KEY (503 model_unavailable otherwise) and APP_URL or
   * MILESTONE_MCP_URL.
   *
   * @returns Console events, one JSON object per line
   *
   * @throws {@link Agents.AgentConsoleTurnError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  agentConsoleTurn(
    request: Agents.AgentConsoleTurnRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Agents.AgentConsoleTurnError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/agents/console"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiAgentsConsoleRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.AgentConsoleTurnError,
      },
      options,
    );
  }

  /**
   * Create a mandate and its bearer token (shown once)
   *
   * @remarks
   * People only. "approve" needs an approval cap; fund caps come in pairs and need "fund";
   * auto-fund needs both fund caps. The token is stored as its sha256 and returned only here, with
   * the MCP URL and header to use it.
   *
   * @returns { mandate, token, shownOnce, mcp: { url, header } }
   *
   * @throws {@link Agents.CreateMandateError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  createMandate(
    request: Agents.CreateMandateRequestParams,
    options?: RequestOptions,
  ): ApiPromise<undefined, Agents.CreateMandateError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/agents"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: createMandateRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.CreateMandateError,
      },
      options,
    );
  }

  /**
   * The signed-in user's agent mandates, newest first (never the tokens)
   *
   * @remarks
   * People only; a request with an Authorization header is refused (403
   * agents_cannot_manage_mandates).
   *
   * @returns { userId, mandates }
   *
   * @throws {@link Agents.ListMandatesError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  listMandates(options?: RequestOptions): ApiPromise<undefined, Agents.ListMandatesError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/agents"),
        auth: this.#auth.roleCookie,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.ListMandatesError,
      },
      options,
    );
  }

  /**
   * End an MCP session
   *
   * @remarks
   * Not supported. The MCP server is stateless (Streamable HTTP without sessions), so DELETE
   * answers 405.
   *
   * @throws {@link Agents.McpDeleteError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  mcpDelete(options?: RequestOptions): ApiPromise<undefined, Agents.McpDeleteError> {
    return this.#rawClient.execute(
      {
        method: "DELETE",
        urlTemplate: this.#servers.default("/api/mcp"),
        auth: this.#auth.mandateToken,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.McpDeleteError,
      },
      options,
    );
  }

  /**
   * Open an MCP event stream
   *
   * @remarks
   * Not supported. The MCP server is stateless (Streamable HTTP without sessions), so GET answers
   * 405.
   *
   * @throws {@link Agents.McpGetError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  mcpGet(options?: RequestOptions): ApiPromise<undefined, Agents.McpGetError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/mcp"),
        auth: this.#auth.mandateToken,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.McpGetError,
      },
      options,
    );
  }

  /**
   * The Milestone MCP server (Streamable HTTP, stateless, JSON-RPC)
   *
   * @remarks
   * Authenticated by a mandate token; the agent acts as the mandate's user through the same routes
   * a human uses, and every call, refused ones included, is audited. Seven tools: list_contracts,
   * get_milestone, get_ledger, draft_contract, fund_milestone, deliver_milestone,
   * respond_to_review. list_contracts carries each contract's PayPal AUP check (aupCheck);
   * fund_milestone refuses a contract whose check is not clear. See docs/mcp.md.
   *
   * @returns JSON-RPC response
   *
   * @throws {@link Agents.McpPostError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  mcpPost(
    request: Agents.McpPostRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Agents.McpPostError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/mcp"),
        auth: this.#auth.mandateToken,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: s.record(s.string(), s.unknown()) },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.McpPostError,
      },
      options,
    );
  }

  /**
   * Revoke a mandate (idempotent); the agent is refused from its next call
   *
   * @remarks
   * People only.
   *
   * @returns { ok, changed, mandate }
   *
   * @throws {@link Agents.RevokeMandateError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  revokeMandate(
    request: Agents.RevokeMandateRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Agents.RevokeMandateError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/agents/{id}/revoke"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.RevokeMandateError,
      },
      options,
    );
  }

  /**
   * Change a live mandate's funding terms
   *
   * @remarks
   * People only. Only fundCap, fundTotalCap (or their Minor forms) and autoFundNext can change; a
   * key left out keeps its value, null clears a cap. Actions, approval cap, currency and expiry
   * never change: revoke and create anew.
   *
   * @returns { ok, changed, mandate }
   *
   * @throws {@link Agents.UpdateMandateFundingError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  updateMandateFunding(
    request: Agents.UpdateMandateFundingRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Agents.UpdateMandateFundingError> {
    return this.#rawClient.execute(
      {
        method: "PATCH",
        urlTemplate: this.#servers.default("/api/agents/{id}"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiAgentsRequestSchema },
      },
      {
        success: { kind: "empty" },
        errorFactory: Agents.UpdateMandateFundingError,
      },
      options,
    );
  }
}

export namespace Agents {
  export type AgentConsoleTurnRequest = {
    body: ApiAgentsConsoleRequest;
  };

  export class AgentConsoleTurnError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<AgentConsoleTurnError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 401, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 503, kind: "error4", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type CreateMandateRequestParams = {
    body: CreateMandateRequest;
  };

  export class CreateMandateError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Declared<"error2", Error> | Undeclared;

    static readonly errors: ErrorDecoders<CreateMandateError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export class ListMandatesError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<ListMandatesError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export class McpDeleteError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<McpDeleteError> = [
      { on: 405, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export class McpGetError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Undeclared;

    static readonly errors: ErrorDecoders<McpGetError> = [
      { on: 405, kind: "error", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type McpPostRequest = {
    body: Record<string, unknown>;
  };

  export class McpPostError extends ApiError {
    declare readonly payload: Declared<"error401", undefined> | Declared<"error403", undefined> | Undeclared;

    static readonly errors: ErrorDecoders<McpPostError> = [
      { on: 401, kind: "error401", decode: { kind: "empty" } },
      { on: 403, kind: "error403", decode: { kind: "empty" } },
    ];
  }

  export type RevokeMandateRequest = {
    id: string;
  };

  export class RevokeMandateError extends ApiError {
    declare readonly payload: Declared<"error", Error> | Declared<"error2", Error> | Undeclared;

    static readonly errors: ErrorDecoders<RevokeMandateError> = [
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error2", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type UpdateMandateFundingRequest = {
    id: string;
    body: ApiAgentsRequest;
  };

  export class UpdateMandateFundingError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<UpdateMandateFundingError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
