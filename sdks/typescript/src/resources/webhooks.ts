import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import {
  apiWebhooksGithubResponseSchema,
  type ApiWebhooksGithubResponse,
} from "../models/api-webhooks-github-response.js";
import {
  apiWebhooksPaypalResponseSchema,
  type ApiWebhooksPaypalResponse,
} from "../models/api-webhooks-paypal-response.js";
import { errorSchema, type Error } from "../models/error.js";
import {
  gitHubPullRequestEventSchema,
  type GitHubPullRequestEvent,
} from "../models/git-hub-pull-request-event.js";
import { payPalWebhookEventSchema, type PayPalWebhookEvent } from "../models/pay-pal-webhook-event.js";
import type { Servers } from "../servers.js";

export class Webhooks {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * GitHub repository webhook receiver
   *
   * @remarks
   * Verified with the X-Hub-Signature-256 HMAC against GITHUB_WEBHOOK_SECRET and stored once by
   * X-GitHub-Delivery. A merged pull request from a branch named m<seq>-... on a contract's
   * repository creates a delivery and a verify job. Everything else is ignored. With DEMO_MODE=1 a
   * pull request whose clone_url is not DEMO_REPO_URL is refused with 403 and a delivery.refused
   * audit row; no delivery is stored and no job is queued.
   *
   * @returns Accepted
   *
   * @throws {@link Webhooks.ReceiveGitHubWebhookError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  receiveGitHubWebhook(
    request: Webhooks.ReceiveGitHubWebhookRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiWebhooksGithubResponse, Webhooks.ReceiveGitHubWebhookError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/webhooks/github"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [
          { name: "X-Hub-Signature-256", value: request.xHubSignature256, schema: s.string() },
          { name: "X-GitHub-Delivery", value: request.xGitHubDelivery, schema: s.string() },
          { name: "X-GitHub-Event", value: request.xGitHubEvent, schema: s.string() },
          { name: "Idempotency-Key", value: uuid(), schema: s.string() },
        ],
        body: { kind: "json", value: request.body, schema: gitHubPullRequestEventSchema },
      },
      {
        success: { kind: "json", schema: apiWebhooksGithubResponseSchema },
        errorFactory: Webhooks.ReceiveGitHubWebhookError,
      },
      options,
    );
  }

  /**
   * PayPal webhook receiver
   *
   * @remarks
   * Verified with PayPal's verify-webhook-signature call against PAYPAL_WEBHOOK_ID, stored once by
   * event id, then routed. In PAYPAL_MODE=simulated the signature call is replaced by the
   * X-Milestone-Simulated header (the shared SIMULATED_WEBHOOK_SECRET, default "dev"), which the
   * simulator sends itself about 1.5 seconds after a capture, payout or refund. Handled events:
   * CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED,
   * PAYMENT.PAYOUTS-ITEM.* and PAYMENT.PAYOUTSBATCH.DENIED. Others are stored for the audit log.
   * Returns 500 when an event is not processed yet so PayPal redelivers.
   *
   * @returns Accepted
   *
   * @throws {@link Webhooks.ReceivePayPalWebhookError} when the API answers with an error status —
   * narrow on `err.payload.kind`
   *
   * @throws {@link MilestoneApiError} when no usable response was produced: a connection failure, a
   * timeout, a body that would not decode, a value that would not encode, or a credential that
   * could not be obtained
   */
  receivePayPalWebhook(
    request: Webhooks.ReceivePayPalWebhookRequest,
    options?: RequestOptions,
  ): ApiPromise<ApiWebhooksPaypalResponse, Webhooks.ReceivePayPalWebhookError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/webhooks/paypal"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [
          {
            name: "PAYPAL-TRANSMISSION-ID",
            value: request.paypalTransmissionId,
            schema: s.optional(s.string()),
          },
          {
            name: "PAYPAL-TRANSMISSION-TIME",
            value: request.paypalTransmissionTime,
            schema: s.optional(s.string()),
          },
          {
            name: "PAYPAL-TRANSMISSION-SIG",
            value: request.paypalTransmissionSig,
            schema: s.optional(s.string()),
          },
          { name: "PAYPAL-CERT-URL", value: request.paypalCertUrl, schema: s.optional(s.string()) },
          { name: "PAYPAL-AUTH-ALGO", value: request.paypalAuthAlgo, schema: s.optional(s.string()) },
          { name: "Idempotency-Key", value: uuid(), schema: s.string() },
        ],
        body: { kind: "json", value: request.body, schema: payPalWebhookEventSchema },
      },
      {
        success: { kind: "json", schema: apiWebhooksPaypalResponseSchema },
        errorFactory: Webhooks.ReceivePayPalWebhookError,
      },
      options,
    );
  }
}

export namespace Webhooks {
  export type ReceiveGitHubWebhookRequest = {
    xHubSignature256: string;
    xGitHubDelivery: string;
    xGitHubEvent: string;
    body: GitHubPullRequestEvent;
  };

  export class ReceiveGitHubWebhookError extends ApiError {
    declare readonly payload:
      | Declared<"error400", undefined>
      | Declared<"error", Error>
      | Declared<"error500", undefined>
      | Undeclared;

    static readonly errors: ErrorDecoders<ReceiveGitHubWebhookError> = [
      { on: 400, kind: "error400", decode: { kind: "empty" } },
      { on: 403, kind: "error", decode: { kind: "json", schema: errorSchema } },
      { on: 500, kind: "error500", decode: { kind: "empty" } },
    ];
  }

  export type ReceivePayPalWebhookRequest = {
    paypalTransmissionId?: string;
    paypalTransmissionTime?: string;
    paypalTransmissionSig?: string;
    paypalCertUrl?: string;
    paypalAuthAlgo?: string;
    body: PayPalWebhookEvent;
  };

  export class ReceivePayPalWebhookError extends ApiError {
    declare readonly payload: Declared<"error400", undefined> | Declared<"error500", undefined> | Undeclared;

    static readonly errors: ErrorDecoders<ReceivePayPalWebhookError> = [
      { on: 400, kind: "error400", decode: { kind: "empty" } },
      { on: 500, kind: "error500", decode: { kind: "empty" } },
    ];
  }
}
