<!-- Generated file — do not edit; regenerated with the SDK. -->

# Paypal — operations

Accessor: `client.paypal` · Source: `src/resources/paypal.ts` · 1 operation · Request types: namespace `Paypal`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### getClientToken

- **Signature**: `getClientToken(options?: RequestOptions): ApiPromise<ApiPaypalClientTokenResponse, ApiError>`
- **Wire**: `GET /api/paypal/client-token`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `ApiPaypalClientTokenResponse`
- **Error**: `MilestoneApiError` with `kind: "api"` — untyped, `payload.kind` always `"undeclared"`

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiPaypalClientTokenResponse` | `apiPaypalClientTokenResponseSchema` | `src/models/api-paypal-client-token-response.ts` |

