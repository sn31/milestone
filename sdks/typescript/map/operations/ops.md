<!-- Generated file — do not edit; regenerated with the SDK. -->

# Ops — operations

Accessor: `client.ops` · Source: `src/resources/ops.ts` · 3 operations · Request and error types: namespace `Ops`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### reconcileNow

- **Signature**: `reconcileNow(options?: RequestOptions): ApiPromise<undefined, Ops.ReconcileNowError>`
- **Wire**: `POST /api/ops/reconcile`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Ops.ReconcileNowError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"error2"` [503] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### resolveAupReview

- **Signature**: `resolveAupReview(request: Ops.ResolveAupReviewRequest, options?: RequestOptions): ApiPromise<ApiOpsAupResponse, Ops.ResolveAupReviewError>`
- **Wire**: `POST /api/ops/aup/{contractId}`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiOpsAupResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Ops.ResolveAupReviewError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error409"` [409] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Ops.ResolveAupReviewRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `contractId` | `path` | `string` | yes |
| `body` | `body` | `ApiOpsAupRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiOpsAupRequest` | `apiOpsAupRequestSchema` | `src/models/api-ops-aup-request.ts` |
| `ApiOpsAupResponse` | `apiOpsAupResponseSchema` | `src/models/api-ops-aup-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### resolveOperatorCase

- **Signature**: `resolveOperatorCase(request: Ops.ResolveOperatorCaseRequest, options?: RequestOptions): ApiPromise<ApiOpsResolveResponse, Ops.ResolveOperatorCaseError>`
- **Wire**: `POST /api/ops/{milestoneId}/resolve`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiOpsResolveResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Ops.ResolveOperatorCaseError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Ops.ResolveOperatorCaseRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `milestoneId` | `path` | `string` | yes |
| `body` | `body` | `ApiOpsResolveRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiOpsResolveRequest` | `apiOpsResolveRequestSchema` | `src/models/api-ops-resolve-request.ts` |
| `ApiOpsResolveResponse` | `apiOpsResolveResponseSchema` | `src/models/api-ops-resolve-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

