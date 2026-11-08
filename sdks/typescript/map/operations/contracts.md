<!-- Generated file — do not edit; regenerated with the SDK. -->

# Contracts — operations

Accessor: `client.contracts` · Source: `src/resources/contracts.ts` · 3 operations · Request and error types: namespace `Contracts`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### approveContract

- **Signature**: `approveContract(request: Contracts.ApproveContractRequest, options?: RequestOptions): ApiPromise<undefined, Contracts.ApproveContractError>`
- **Wire**: `POST /api/contracts/{id}/approve`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Contracts.ApproveContractError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"error"` [409] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Contracts.ApproveContractRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### createContract

- **Signature**: `createContract(request: Contracts.CreateContractRequest, options?: RequestOptions): ApiPromise<undefined, Contracts.CreateContractError>`
- **Wire**: `POST /api/contracts`
- **Auth**: `roleCookie`
- **Request body**: `application/x-www-form-urlencoded;charset=UTF-8` — every field marked `form`
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Contracts.CreateContractError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"error"` [502] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Contracts.CreateContractRequest` (5):

| Field | Channel | Type | Req | Default |
| --- | --- | --- | --- | --- |
| `scope` | `form` | `string` | yes | — |
| `total` | `form` | `number` | yes | — |
| `title` | `form` | `string` | no | — |
| `currency` | `form` | `string` | no | `"USD"` |
| `repo` | `form` | `string` | no | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### editCriteria

- **Signature**: `editCriteria(request: Contracts.EditCriteriaRequest, options?: RequestOptions): ApiPromise<undefined, Contracts.EditCriteriaError>`
- **Wire**: `PATCH /api/contracts/{id}/criteria`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Contracts.EditCriteriaError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error409"` [409] no body · `"error422"` [422] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Contracts.EditCriteriaRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiContractsCriteriaRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiContractsCriteriaRequest` | `apiContractsCriteriaRequestSchema` | `src/models/api-contracts-criteria-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

