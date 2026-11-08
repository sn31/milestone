<!-- Generated file — do not edit; regenerated with the SDK. -->

# Vault — operations

Accessor: `client.vault` · Source: `src/resources/vault.ts` · 4 operations · Request and error types: namespace `Vault`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### getSavedPayPal

- **Signature**: `getSavedPayPal(options?: RequestOptions): ApiPromise<undefined, Vault.GetSavedPayPalError>`
- **Wire**: `GET /api/vault`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Vault.GetSavedPayPalError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### removeSavedPayPal

- **Signature**: `removeSavedPayPal(request?: Vault.RemoveSavedPayPalRequest, options?: RequestOptions): ApiPromise<undefined, Vault.RemoveSavedPayPalError>`
- **Wire**: `DELETE /api/vault`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Vault.RemoveSavedPayPalError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"error2"` [404] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Vault.RemoveSavedPayPalRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `query` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

### returnFromSavePayPal

- **Signature**: `returnFromSavePayPal(request?: Vault.ReturnFromSavePayPalRequest, options?: RequestOptions): ApiPromise<undefined, Vault.ReturnFromSavePayPalError>`
- **Wire**: `GET /api/vault/return`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Vault.ReturnFromSavePayPalError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Vault.ReturnFromSavePayPalRequest` (2):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `approvalTokenId` | `query` | `approval_token_id` | `string` | no |
| `cancelled` | `query` | — | `string` | no |

### startSavePayPal

- **Signature**: `startSavePayPal(options?: RequestOptions): ApiPromise<ApiVaultStartResponse, Vault.StartSavePayPalError>`
- **Wire**: `POST /api/vault/start`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `ApiVaultStartResponse`
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Vault.StartSavePayPalError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"error2"` [409] `Error` · `"payPalError1"` [502] `PayPalError1` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiVaultStartResponse` | `apiVaultStartResponseSchema` | `src/models/api-vault-start-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |
| `PayPalError1` | `payPalError1Schema` | `src/models/pay-pal-error1.ts` |

