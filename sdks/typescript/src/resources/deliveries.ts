import type { AuthSchemes } from "../auth-schemes.js";
import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import type { FileInput } from "../core/binary.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiMilestonesDeliverResponseSchema,
  type ApiMilestonesDeliverResponse,
} from "../models/api-milestones-deliver-response.js";
import {
  apiMilestonesUploadResponseSchema,
  type ApiMilestonesUploadResponse,
} from "../models/api-milestones-upload-response.js";
import { errorSchema, type Error } from "../models/error.js";
import {
  manualDeliveryRequestSchema,
  type ManualDeliveryRequest,
} from "../models/manual-delivery-request.js";
import type { Servers } from "../servers.js";

export class Deliveries {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;

  constructor(rawClient: RawClient, servers: Servers, auth: AuthSchemes) {
    this.#rawClient = rawClient;
    this.#servers = servers;
    this.#auth = auth;
  }

  /**
   * Deliver a commit from a repository (manual delivery)
   *
   * @remarks
   * The contract's freelancer only, while the milestone is funded or held. The ref (default HEAD)
   * is resolved to a commit with git ls-remote, a delivery with source `manual` is stored in the
   * GitHub webhook's payload shape (the baseline for the client's test suite is the milestone's
   * funding-time sha), and a verify job is queued. The same milestone and commit give the same
   * delivery id, so a repeat returns `duplicate: true`. With DEMO_MODE=1 (the hosted demo) only
   * DEMO_REPO_URL is accepted (https, compared after normalising); any other repository, or every
   * repository when DEMO_REPO_URL is unset, gets 403 with `reason: demo_repo_only` and a
   * delivery.refused audit row, before ls-remote or a job. In DEMO_MODE the ref must also resolve
   * to a branch or tag tip (or HEAD) of that repository: a pull request head (refs/pull/N/head) or
   * any other commit id is 422, nothing stored or queued.
   *
   * @returns Delivery stored and verification queued
   *
   * @throws {@link Deliveries.DeliverRepositoryError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  deliverRepository(
    request: Deliveries.DeliverRepositoryRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiMilestonesDeliverResponse, Deliveries.DeliverRepositoryError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/milestones/{id}/deliver"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: manualDeliveryRequestSchema },
      },
      {
        success: { kind: "json", schema: apiMilestonesDeliverResponseSchema },
        errorFactory: Deliveries.DeliverRepositoryError,
      },
      options,
    );
  }

  /**
   * Download or view a delivered file
   *
   * @remarks
   * Only the contract's client and freelancer. Served with a sandboxing Content-Security-Policy and
   * nosniff; images and PDFs open inline, everything else downloads as an attachment. The
   * X-File-Sha256 header carries the stored hash. Errors are plain text.
   *
   * @returns The file
   *
   * @throws {@link Deliveries.GetDeliveredFileError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  getDeliveredFile(
    request: Deliveries.GetDeliveredFileRequest,
    options?: RequestOptions,
  ): ApiPromise<undefined, Deliveries.GetDeliveredFileError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/files/{deliveryId}/{name}"),
        auth: this.#auth.roleCookie,
        pathParams: [
          { name: "deliveryId", value: request.deliveryId, schema: s.string() },
          { name: "name", value: request.name, schema: s.string() },
        ],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Deliveries.GetDeliveredFileError,
      },
      options,
    );
  }

  /**
   * Deliver files (upload delivery)
   *
   * @remarks
   * The contract's freelancer only, while the milestone is funded or held. Up to 10 files of 20 MB
   * each, sent as multipart field `files`, optional text field `note`. Files are stored under
   * UPLOAD_DIR/<deliveryId>/ (default var/uploads) with their sha256, a delivery with source
   * `upload` is recorded, and a verify job runs the upload checks (format by magic bytes, size,
   * image dimensions, PDF page count, word count, required strings) and the judgment stage. There
   * is no baseline suite or gaming scan for uploads. Delivered files are untrusted evidence.
   *
   * @returns Files stored and verification queued
   *
   * @throws {@link Deliveries.UploadFilesError} when the API answers with an error status — narrow
   * on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  uploadFiles(
    request: Deliveries.UploadFilesRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiMilestonesUploadResponse, Deliveries.UploadFilesError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/milestones/{id}/upload"),
        auth: this.#auth.roleCookie,
        pathParams: [{ name: "id", value: request.id, schema: s.string() }],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: {
          kind: "multipart",
          value: [
            { kind: "file", name: "files", value: request.files },
            { kind: "text", name: "note", value: request.note, schema: s.optional(s.string()) },
          ],
        },
      },
      {
        success: { kind: "json", schema: apiMilestonesUploadResponseSchema },
        errorFactory: Deliveries.UploadFilesError,
      },
      options,
    );
  }
}

export namespace Deliveries {
  export type DeliverRepositoryRequest = {
    id: string;
    body: ManualDeliveryRequest;
  };

  export class DeliverRepositoryError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Declared<"error5", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<DeliverRepositoryError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
      { on: 422, kind: "error5", decode: { kind: "json", schema: errorSchema } },
    ];
  }

  export type GetDeliveredFileRequest = {
    deliveryId: string;
    name: string;
  };

  export class GetDeliveredFileError extends ApiError {
    declare readonly payload: Declared<"error403", string> | Declared<"error404", string> | Undeclared;

    static readonly errors: ErrorDecoders<GetDeliveredFileError> = [
      { on: 403, kind: "error403", decode: { kind: "text", schema: s.string() } },
      { on: 404, kind: "error404", decode: { kind: "text", schema: s.string() } },
    ];
  }

  export type UploadFilesRequest = {
    id: string;
    /**
     * A delivered file. The route reads every `files` field, so repeat the field to send up to 10
     * files in one delivery (described as one field because SDK generators do not support file
     * arrays).
     */
    files: FileInput;
    /** Optional note to the reviewer */
    note?: string;
  };

  export class UploadFilesError extends ApiError {
    declare readonly payload:
      | Declared<"error", Error>
      | Declared<"error2", Error>
      | Declared<"error3", Error>
      | Declared<"error4", Error>
      | Declared<"error5", Error>
      | Undeclared;

    static readonly errors: ErrorDecoders<UploadFilesError> = [
      { on: 400, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 403, kind: "error2", decode: { kind: "json", schema: errorSchema } },
      { on: 404, kind: "error3", decode: { kind: "json", schema: errorSchema } },
      { on: 409, kind: "error4", decode: { kind: "json", schema: errorSchema } },
      { on: 413, kind: "error5", decode: { kind: "json", schema: errorSchema } },
    ];
  }
}
