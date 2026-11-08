<!-- Generated file — do not edit; regenerated with the SDK. -->

# Agents — operations

Accessor: `client.agents` · Source: `src/resources/agents.ts` · 8 operations · Request and error types: namespace `Agents`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `milestone-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### agentConsoleTurn

- **Signature**: `agentConsoleTurn(request: Agents.AgentConsoleTurnRequest, options?: RequestOptions): ApiPromise<undefined, Agents.AgentConsoleTurnError>`
- **Wire**: `POST /api/agents/console`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.AgentConsoleTurnError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [503] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Agents.AgentConsoleTurnRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `ApiAgentsConsoleRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiAgentsConsoleRequest` | `apiAgentsConsoleRequestSchema` | `src/models/api-agents-console-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### createMandate

- **Signature**: `createMandate(request: Agents.CreateMandateRequestParams, options?: RequestOptions): ApiPromise<undefined, Agents.CreateMandateError>`
- **Wire**: `POST /api/agents`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.CreateMandateError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Agents.CreateMandateRequestParams` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `CreateMandateRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `CreateMandateRequest` | `createMandateRequestSchema` | `src/models/create-mandate-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

### listMandates

- **Signature**: `listMandates(options?: RequestOptions): ApiPromise<undefined, Agents.ListMandatesError>`
- **Wire**: `GET /api/agents`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.ListMandatesError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### mcpDelete

- **Signature**: `mcpDelete(options?: RequestOptions): ApiPromise<undefined, Agents.McpDeleteError>`
- **Wire**: `DELETE /api/mcp`
- **Auth**: `mandateToken`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.McpDeleteError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [405] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### mcpGet

- **Signature**: `mcpGet(options?: RequestOptions): ApiPromise<undefined, Agents.McpGetError>`
- **Wire**: `GET /api/mcp`
- **Auth**: `mandateToken`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.McpGetError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [405] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### mcpPost

- **Signature**: `mcpPost(request: Agents.McpPostRequest, options?: RequestOptions): ApiPromise<undefined, Agents.McpPostError>`
- **Wire**: `POST /api/mcp`
- **Auth**: `mandateToken`
- **Request body**: `application/json` — the `body` field, a bare top-level JSON map with no fixed keys
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.McpPostError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error401"` [401] no body · `"error403"` [403] no body · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Agents.McpPostRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `Record<string, unknown>` | yes |

### revokeMandate

- **Signature**: `revokeMandate(request: Agents.RevokeMandateRequest, options?: RequestOptions): ApiPromise<undefined, Agents.RevokeMandateError>`
- **Wire**: `POST /api/agents/{id}/revoke`
- **Auth**: `roleCookie`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.RevokeMandateError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [403] `Error` · `"error2"` [404] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Agents.RevokeMandateRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Error` | `errorSchema` | `src/models/error.ts` |

### updateMandateFunding

- **Signature**: `updateMandateFunding(request: Agents.UpdateMandateFundingRequest, options?: RequestOptions): ApiPromise<undefined, Agents.UpdateMandateFundingError>`
- **Wire**: `PATCH /api/agents/{id}`
- **Auth**: `roleCookie`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `MilestoneApiError` with `kind: "api"`, an instance of `Agents.UpdateMandateFundingError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields** — `Agents.UpdateMandateFundingRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `id` | `path` | `string` | yes |
| `body` | `body` | `ApiAgentsRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiAgentsRequest` | `apiAgentsRequestSchema` | `src/models/api-agents-request.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |

