<!-- Generated file — do not edit; regenerated with the SDK. -->

# Milestones — operations

Accessor: `client.milestones` · Source: `src/resources/milestones.ts` · 5 operations · Request and error types: namespace `Milestones`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### captureFunding

- **Signature**: `captureFunding(request: Milestones.CaptureFundingRequest, options?: RequestOptions): ApiPromise<CaptureResult, Milestones.CaptureFundingError>`
- **Wire**: `POST /api/milestones/{id}/capture`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `CaptureResult`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Milestones.CaptureFundingError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Milestones.CaptureFundingRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiMilestonesCaptureRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiMilestonesCaptureRequest` | `apiMilestonesCaptureRequestSchema` | `src/models/api-milestones-capture-request.ts` |
| `CaptureResult` | `captureResultSchema` | `src/models/capture-result.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

### createFundingOrder

- **Signature**: `createFundingOrder(request: Milestones.CreateFundingOrderRequest, options?: RequestOptions): ApiPromise<ApiMilestonesOrderResponse, Milestones.CreateFundingOrderError>`
- **Wire**: `POST /api/milestones/{id}/order`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiMilestonesOrderResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Milestones.CreateFundingOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"error2"` [404] `Error` · `"error3"` [409] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Milestones.CreateFundingOrderRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiMilestonesOrderResponse` | `apiMilestonesOrderResponseSchema` | `src/models/api-milestones-order-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

### getMilestoneStatus

- **Signature**: `getMilestoneStatus(request: Milestones.GetMilestoneStatusRequest, options?: RequestOptions): ApiPromise<undefined, Milestones.GetMilestoneStatusError>`
- **Wire**: `GET /api/milestones/{id}/status`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Milestones.GetMilestoneStatusError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Milestones.GetMilestoneStatusRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### getMilestoneStatuses

- **Signature**: `getMilestoneStatuses(request: Milestones.GetMilestoneStatusesRequest, options?: RequestOptions): ApiPromise<undefined, Milestones.GetMilestoneStatusesError>`
- **Wire**: `GET /api/milestones/status`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Milestones.GetMilestoneStatusesError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error304"` [304] no body · `"error"` [400] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Milestones.GetMilestoneStatusesRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `ids` | `query` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### reviewMilestone

- **Signature**: `reviewMilestone(request: Milestones.ReviewMilestoneRequest, options?: RequestOptions): ApiPromise<ApiMilestonesReviewResponse2, Milestones.ReviewMilestoneError>`
- **Wire**: `POST /api/milestones/{id}/review`
- **Auth**: any of `roleCookie`, `mandateToken` — the first one configured is sent
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiMilestonesReviewResponse2`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Milestones.ReviewMilestoneError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [404] `Error` · `"apiMilestonesReview409Error1"` [409] `ApiMilestonesReview409Error1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Milestones.ReviewMilestoneRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiMilestonesReviewRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiMilestonesReviewRequest` | `apiMilestonesReviewRequestSchema` | `src/models/api-milestones-review-request.ts` |
| `ApiMilestonesReviewResponse2` | `apiMilestonesReviewResponse2Schema` | `src/models/unions/api-milestones-review-response2.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `ApiMilestonesReview409Error1` | `apiMilestonesReview409Error1Schema` | `src/models/api-milestones-review409-error1.ts` |

