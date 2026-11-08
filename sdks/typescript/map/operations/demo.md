<!-- Generated file — do not edit; regenerated with the SDK. -->

# Demo — operations

Accessor: `client.demo` · Source: `src/resources/demo.ts` · 1 operation · Request and error types: namespace `Demo`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### resetDemo

- **Signature**: `resetDemo(options?: RequestOptions): ApiPromise<undefined, Demo.ResetDemoError>`
- **Wire**: `POST /api/demo/reset`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Demo.ResetDemoError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error303"` [303] no body · `"error"` [404] `Error` · `"error429"` [429] no body · `"error2"` [500] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

