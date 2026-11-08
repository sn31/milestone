import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import { errorSchema, type Error } from "../models/error.js";
import type { Servers } from "../servers.js";

export class Demo {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * Put the hosted demo back to the showcase data and empty uploaded files
   *
   * @remarks
   * Exists only with DEMO_MODE=1 (404 otherwise). At most once every 30 s across all visitors (429
   * with Retry-After). A form post (the demo band's Reset demo button) gets a 303 to home; a JSON
   * caller gets { ok: true }.
   *
   * @returns { ok: true }
   *
   * @throws {@link Demo.ResetDemoError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  resetDemo(options?: RequestOptions): ApiPromise<undefined, Demo.ResetDemoError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/demo/reset"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Demo.ResetDemoError,
      },
      options,
    );
  }
}

export namespace Demo {
  export class ResetDemoError extends ApiError {
    declare readonly payload:
      | Declared<"error303", undefined>
      | Declared<"error", Error>
      | Declared<"error429", undefined>
      | Declared<"error2", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<ResetDemoError> = [
      { on: 303, kind: "error303", decode: { kind: "empty" } },
      { on: 404, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 429, kind: "error429", decode: { kind: "empty" } },
      { on: 500, kind: "error2", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
