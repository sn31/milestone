<!-- Generated file — do not edit; regenerated with the SDK. -->

# Webhooks — operations

Accessor: `client.webhooks` · Source: `src/resources/webhooks.ts` · 2 operations · Request and error types: namespace `Webhooks`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### receiveGitHubWebhook

- **Signature**: `receiveGitHubWebhook(request: Webhooks.ReceiveGitHubWebhookRequest, options?: RequestOptions): ApiPromise<ApiWebhooksGithubResponse, Webhooks.ReceiveGitHubWebhookError>`
- **Wire**: `POST /api/webhooks/github`
- **Auth**: none — public; no credential is sent
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiWebhooksGithubResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Webhooks.ReceiveGitHubWebhookError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error400"` [400] no body · `"error"` [403] `Error` · `"error500"` [500] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Webhooks.ReceiveGitHubWebhookRequest` (4):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `xHubSignature256` | `header` | `X-Hub-Signature-256` | `string` | yes |
| `xGitHubDelivery` | `header` | `X-GitHub-Delivery` | `string` | yes |
| `xGitHubEvent` | `header` | `X-GitHub-Event` | `string` | yes |
| `body` | `body` | — | `GitHubPullRequestEvent` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `GitHubPullRequestEvent` | `gitHubPullRequestEventSchema` | `src/models/git-hub-pull-request-event.ts` |
| `ApiWebhooksGithubResponse` | `apiWebhooksGithubResponseSchema` | `src/models/api-webhooks-github-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### receivePayPalWebhook

- **Signature**: `receivePayPalWebhook(request: Webhooks.ReceivePayPalWebhookRequest, options?: RequestOptions): ApiPromise<ApiWebhooksPaypalResponse, Webhooks.ReceivePayPalWebhookError>`
- **Wire**: `POST /api/webhooks/paypal`
- **Auth**: none — public; no credential is sent
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiWebhooksPaypalResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Webhooks.ReceivePayPalWebhookError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error400"` [400] no body · `"error500"` [500] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Webhooks.ReceivePayPalWebhookRequest` (6):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `paypalTransmissionId` | `header` | `PAYPAL-TRANSMISSION-ID` | `string` | no |
| `paypalTransmissionTime` | `header` | `PAYPAL-TRANSMISSION-TIME` | `string` | no |
| `paypalTransmissionSig` | `header` | `PAYPAL-TRANSMISSION-SIG` | `string` | no |
| `paypalCertUrl` | `header` | `PAYPAL-CERT-URL` | `string` | no |
| `paypalAuthAlgo` | `header` | `PAYPAL-AUTH-ALGO` | `string` | no |
| `body` | `body` | — | `PayPalWebhookEvent` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `PayPalWebhookEvent` | `payPalWebhookEventSchema` | `src/models/pay-pal-webhook-event.ts` |
| `ApiWebhooksPaypalResponse` | `apiWebhooksPaypalResponseSchema` | `src/models/api-webhooks-paypal-response.ts` |

