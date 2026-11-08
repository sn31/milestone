<!-- Generated file — do not edit; regenerated with the SDK. -->

# Dev — operations

Accessor: `client.dev` · Source: `src/resources/dev.ts` · 6 operations · Request and error types: namespace `Dev`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### approveSimulatedOrder

- **Signature**: `approveSimulatedOrder(request: Dev.ApproveSimulatedOrderRequest, options?: RequestOptions): ApiPromise<undefined, Dev.ApproveSimulatedOrderError>`
- **Wire**: `GET /api/dev/paypal/approve`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Dev.ApproveSimulatedOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"error"` [400] `Error` · `"error2"` [404] `Error` · `"error3"` [409] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Dev.ApproveSimulatedOrderRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `order` | `query` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### approveSimulatedVaultSetup

- **Signature**: `approveSimulatedVaultSetup(request: Dev.ApproveSimulatedVaultSetupRequest, options?: RequestOptions): ApiPromise<undefined, Dev.ApproveSimulatedVaultSetupError>`
- **Wire**: `GET /api/dev/paypal/vault-approve`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Dev.ApproveSimulatedVaultSetupError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"error"` [400] `Error` · `"error2"` [404] `Error` · `"error3"` [409] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Dev.ApproveSimulatedVaultSetupRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `token` | `query` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### armSimulatedPayoutFailure

- **Signature**: `armSimulatedPayoutFailure(request?: Dev.ArmSimulatedPayoutFailureRequest, options?: RequestOptions): ApiPromise<ApiDevPaypalFailResponse, Dev.ArmSimulatedPayoutFailureError>`
- **Wire**: `POST /api/dev/paypal/fail`
- **Auth**: none — public; no credential is sent
- **Request body**: `application/x-www-form-urlencoded;charset=UTF-8` — every field marked `form`
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiDevPaypalFailResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Dev.ArmSimulatedPayoutFailureError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Dev.ArmSimulatedPayoutFailureRequest` (4):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `senderItemId` | `form` | `sender_item_id` | `string` | no | — |
| `milestoneId` | `form` | — | `string` | no | — |
| `party` | `form` | — | `Party` | no | `Party.Freelancer` |
| `reason` | `form` | — | `string` | no | `"RECEIVER_ACCOUNT_LOCKED"` |

| Type | Schema value | Source |
| --- | --- | --- |
| `Party` | `partySchema` | `src/models/party.ts` |
| `ApiDevPaypalFailResponse` | `apiDevPaypalFailResponseSchema` | `src/models/api-dev-paypal-fail-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### getPayPalMode

- **Signature**: `getPayPalMode(options?: RequestOptions): ApiPromise<ApiDevPaypalModeResponse, ApiError>`
- **Wire**: `GET /api/dev/paypal/mode`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `ApiDevPaypalModeResponse`
- **Error**: `MilestoneApiError` with `kind: "api"` — untyped, `payload.kind` always `"undeclared"`

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiDevPaypalModeResponse` | `apiDevPaypalModeResponseSchema` | `src/models/api-dev-paypal-mode-response.ts` |

### listArmedFailures

- **Signature**: `listArmedFailures(options?: RequestOptions): ApiPromise<ApiDevPaypalFailResponse1, Dev.ListArmedFailuresError>`
- **Wire**: `GET /api/dev/paypal/fail`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `ApiDevPaypalFailResponse1`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Dev.ListArmedFailuresError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiDevPaypalFailResponse1` | `apiDevPaypalFailResponse1Schema` | `src/models/api-dev-paypal-fail-response1.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### openSimulatedDispute

- **Signature**: `openSimulatedDispute(request: Dev.OpenSimulatedDisputeRequest, options?: RequestOptions): ApiPromise<undefined, Dev.OpenSimulatedDisputeError>`
- **Wire**: `POST /api/disputes/dev`
- **Auth**: none — public; no credential is sent
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Dev.OpenSimulatedDisputeError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [404] `Error` · `"error3"` [409] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Dev.OpenSimulatedDisputeRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `ApiDisputesDevRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiDisputesDevRequest` | `apiDisputesDevRequestSchema` | `src/models/api-disputes-dev-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

