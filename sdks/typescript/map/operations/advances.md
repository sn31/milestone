<!-- Generated file — do not edit; regenerated with the SDK. -->

# Advances — operations

Accessor: `client.advances` · Source: `src/resources/advances.ts` · 2 operations · Request and error types: namespace `Advances`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### acceptAdvance

- **Signature**: `acceptAdvance(request: Advances.AcceptAdvanceRequest, options?: RequestOptions): ApiPromise<AdvanceAcceptResponse, Advances.AcceptAdvanceError>`
- **Wire**: `POST /api/advances/accept`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `AdvanceAcceptResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Advances.AcceptAdvanceError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"apiAdvancesAccept409Error1"` [409] `ApiAdvancesAccept409Error1` · `"error4"` [503] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Advances.AcceptAdvanceRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `ApiAdvancesAcceptRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiAdvancesAcceptRequest` | `apiAdvancesAcceptRequestSchema` | `src/models/api-advances-accept-request.ts` |
| `AdvanceAcceptResponse` | `advanceAcceptResponseSchema` | `src/models/advance-accept-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `ApiAdvancesAccept409Error1` | `apiAdvancesAccept409Error1Schema` | `src/models/api-advances-accept409-error1.ts` |

### getAdvanceOffer

- **Signature**: `getAdvanceOffer(request: Advances.GetAdvanceOfferRequest, options?: RequestOptions): ApiPromise<AdvanceOfferResponse, Advances.GetAdvanceOfferError>`
- **Wire**: `GET /api/advances/offer`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `AdvanceOfferResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Advances.GetAdvanceOfferError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Advances.GetAdvanceOfferRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `milestoneId` | `query` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `AdvanceOfferResponse` | `advanceOfferResponseSchema` | `src/models/advance-offer-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

