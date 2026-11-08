<!-- Generated file — do not edit; regenerated with the SDK. -->

# Disputes — operations

Accessor: `client.disputes` · Source: `src/resources/disputes.ts` · 2 operations · Request and error types: namespace `Disputes`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### acceptDisputeClaim

- **Signature**: `acceptDisputeClaim(request: Disputes.AcceptDisputeClaimRequest, options?: RequestOptions): ApiPromise<undefined, Disputes.AcceptDisputeClaimError>`
- **Wire**: `POST /api/disputes/{id}/accept`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Disputes.AcceptDisputeClaimError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Disputes.AcceptDisputeClaimRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiDisputesAcceptRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiDisputesAcceptRequest` | `apiDisputesAcceptRequestSchema` | `src/models/api-disputes-accept-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

### submitDisputeEvidence

- **Signature**: `submitDisputeEvidence(request: Disputes.SubmitDisputeEvidenceRequest, options?: RequestOptions): ApiPromise<undefined, Disputes.SubmitDisputeEvidenceError>`
- **Wire**: `POST /api/disputes/{id}/submit`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Disputes.SubmitDisputeEvidenceError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Disputes.SubmitDisputeEvidenceRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiDisputesSubmitRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiDisputesSubmitRequest` | `apiDisputesSubmitRequestSchema` | `src/models/api-disputes-submit-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

