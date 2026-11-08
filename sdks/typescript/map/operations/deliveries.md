<!-- Generated file — do not edit; regenerated with the SDK. -->

# Deliveries — operations

Accessor: `client.deliveries` · Source: `src/resources/deliveries.ts` · 3 operations · Request and error types: namespace `Deliveries`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### deliverRepository

- **Signature**: `deliverRepository(request: Deliveries.DeliverRepositoryRequest, options?: RequestOptions): ApiPromise<ApiMilestonesDeliverResponse, Deliveries.DeliverRepositoryError>`
- **Wire**: `POST /api/milestones/{id}/deliver`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiMilestonesDeliverResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Deliveries.DeliverRepositoryError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"error5"` [422] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Deliveries.DeliverRepositoryRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ManualDeliveryRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ManualDeliveryRequest` | `manualDeliveryRequestSchema` | `src/models/manual-delivery-request.ts` |
| `ApiMilestonesDeliverResponse` | `apiMilestonesDeliverResponseSchema` | `src/models/api-milestones-deliver-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### getDeliveredFile

- **Signature**: `getDeliveredFile(request: Deliveries.GetDeliveredFileRequest, options?: RequestOptions): ApiPromise<undefined, Deliveries.GetDeliveredFileError>`
- **Wire**: `GET /api/files/{deliveryId}/{name}`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Deliveries.GetDeliveredFileError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error403"` [403] `string` · `"error404"` [404] `string` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Deliveries.GetDeliveredFileRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `deliveryId` | `path` | `string` | yes |
| `name` | `path` | `string` | yes |

### uploadFiles

- **Signature**: `uploadFiles(request: Deliveries.UploadFilesRequest, options?: RequestOptions): ApiPromise<ApiMilestonesUploadResponse, Deliveries.UploadFilesError>`
- **Wire**: `POST /api/milestones/{id}/upload`
- **Auth**: `roleCookie`
- **Request body**: `multipart/form-data` — every field marked `form`. `files` is a file part, framed as bytes rather than encoded. The platform writes the boundary, or the SDK does when a file part streams
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiMilestonesUploadResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Deliveries.UploadFilesError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"error5"` [413] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Deliveries.UploadFilesRequest` (3):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `files` | `form` | `FileInput` | yes |
| `note` | `form` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiMilestonesUploadResponse` | `apiMilestonesUploadResponseSchema` | `src/models/api-milestones-upload-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

