# Reference

> Source: [MilestoneApiClient](src/client.ts)

## Contracts

> Source: [Contracts](src/resources/contracts.ts)

<details>
<summary><code>approveContract(request: Contracts.ApproveContractRequest, options?: RequestOptions): ApiPromise&lt;undefined, Contracts.ApproveContractError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Records the caller's approval time. When both have approved, the contract becomes active. Neither party can
approve while the contract's PayPal Acceptable Use Policy check is not clear, keywords_only or cleared by an
operator: 409 with reason aup_unchecked, aup_checking, aup_review or aup_rejected (audited as aup.refused). A
browser form post (Accept text/html) is redirected to /contracts/{id}?aup=<reason> instead.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.contracts.approveContract({ id: "ctr_demo" });
} catch (err) {
  // TODO: Handle 'err' of type Contracts.ApproveContractError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.contracts.approveContract({ id: "ctr_demo" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.contracts.approveContract(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Contracts.ApproveContractError](src/resources/contracts.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.contracts.approveContract(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Contracts.ApproveContractError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>createContract(request: Contracts.CreateContractRequest, options?: RequestOptions): ApiPromise&lt;undefined, Contracts.CreateContractError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Form post from the New contract page. With ANTHROPIC_API_KEY set, Claude compiles the scope; otherwise a
three-milestone demo contract is built. Responds with a 303 redirect to the contract page. The new contract's
PayPal Acceptable Use Policy check starts here: without a model the keyword pass is stored at once (keywords_only,
or review on a hit); with one the contract is "checking" until the worker's aup job stores the result.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.contracts.createContract({ scope: "some example string", total: 1.5 });
} catch (err) {
  // TODO: Handle 'err' of type Contracts.CreateContractError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.contracts.createContract({
  scope: "some example string",
  total: 1.5,
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>scope</code> | <code>string</code> | Plain-English scope |
| <code>total</code> | <code>number</code> | Total in major units, for example 300.00 |
| <code>title?</code> | <code>string</code> | Optional; defaults to the compiled title |
| <code>currency?</code> | <code>string</code> | -<br>**Default**: "USD" |
| <code>repo?</code> | <code>string</code> | owner/name of the delivery repository |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.contracts.createContract(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Contracts.CreateContractError](src/resources/contracts.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.contracts.createContract(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Contracts.CreateContractError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>editCriteria(request: Contracts.EditCriteriaRequest, options?: RequestOptions): ApiPromise&lt;undefined, Contracts.EditCriteriaError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Either party. Body: { milestoneId, operations: [{ op: add | remove | update | reorder, ... }] }. Validated with
the compiler's rules and audited before and after; an edit after one party approved clears both approvals. An
edit that changes the criteria starts a new PayPal Acceptable Use Policy check of the contract text. With
DEMO_MODE=1, test and build commands are limited to npm test and npm run <script>, with no options or shell characters.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.contracts.editCriteria({
    id: "ctr_demo",
    body: { milestoneId: "some example string", operations: [{}] },
  });
} catch (err) {
  // TODO: Handle 'err' of type Contracts.EditCriteriaError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.contracts.editCriteria({
  id: "ctr_demo",
  body: { milestoneId: "some example string", operations: [{}] },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiContractsCriteriaRequest](src/models/api-contracts-criteria-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.contracts.editCriteria(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Contracts.EditCriteriaError](src/resources/contracts.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.contracts.editCriteria(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Contracts.EditCriteriaError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Milestones

> Source: [Milestones](src/resources/milestones.ts)

<details>
<summary><code>captureFunding(request: Milestones.CaptureFundingRequest, options?: RequestOptions): ApiPromise&lt;CaptureResult, Milestones.CaptureFundingError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Client only. Idempotent; a milestone already past draft returns its current status.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.milestones.captureFunding({
    id: "mst_1",
    body: { orderId: "some example string" },
  });
  // TODO: Handle 'response' of type CaptureResult
} catch (err) {
  // TODO: Handle 'err' of type Milestones.CaptureFundingError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.milestones.captureFunding({
  id: "mst_1",
  body: { orderId: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type CaptureResult
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiMilestonesCaptureRequest](src/models/api-milestones-capture-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.milestones.captureFunding(request)`

- **OnSuccess**: <code>[CaptureResult](src/models/capture-result.ts)</code>
- **OnError**: throws <code>[Milestones.CaptureFundingError](src/resources/milestones.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.milestones.captureFunding(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;CaptureResult, Milestones.CaptureFundingError&gt;</code>, with `result.value` of type <code>[CaptureResult](src/models/capture-result.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>createFundingOrder(request: Milestones.CreateFundingOrderRequest, options?: RequestOptions): ApiPromise&lt;ApiMilestonesOrderResponse, Milestones.CreateFundingOrderError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Client only. The contract must be active and the milestone in draft. Repeated calls return the same order.
Refused with 409 and reason aup_unchecked, aup_checking, aup_review or aup_rejected while the contract's PayPal
Acceptable Use Policy check is not clear, keywords_only or cleared (no order is created; audited as aup.refused).


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.milestones.createFundingOrder({ id: "mst_1" });
  // TODO: Handle 'response' of type ApiMilestonesOrderResponse
} catch (err) {
  // TODO: Handle 'err' of type Milestones.CreateFundingOrderError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.milestones.createFundingOrder({ id: "mst_1" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiMilestonesOrderResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.milestones.createFundingOrder(request)`

- **OnSuccess**: <code>[ApiMilestonesOrderResponse](src/models/api-milestones-order-response.ts)</code>
- **OnError**: throws <code>[Milestones.CreateFundingOrderError](src/resources/milestones.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.milestones.createFundingOrder(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiMilestonesOrderResponse, Milestones.CreateFundingOrderError&gt;</code>, with `result.value` of type <code>[ApiMilestonesOrderResponse](src/models/api-milestones-order-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>getMilestoneStatus(request: Milestones.GetMilestoneStatusRequest, options?: RequestOptions): ApiPromise&lt;undefined, Milestones.GetMilestoneStatusError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Read only. The contract page polls it while a milestone is live.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.milestones.getMilestoneStatus({ id: "mst_1" });
} catch (err) {
  // TODO: Handle 'err' of type Milestones.GetMilestoneStatusError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.milestones.getMilestoneStatus({ id: "mst_1" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.milestones.getMilestoneStatus(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Milestones.GetMilestoneStatusError](src/resources/milestones.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.milestones.getMilestoneStatus(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Milestones.GetMilestoneStatusError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>getMilestoneStatuses(request: Milestones.GetMilestoneStatusesRequest, options?: RequestOptions): ApiPromise&lt;undefined, Milestones.GetMilestoneStatusesError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Read only. Sends an ETag; a poll with a matching If-None-Match gets 304. Unknown ids are left out.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.milestones.getMilestoneStatuses({ ids: "mst_1,mst_2,mst_3" });
} catch (err) {
  // TODO: Handle 'err' of type Milestones.GetMilestoneStatusesError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.milestones.getMilestoneStatuses({ ids: "mst_1,mst_2,mst_3" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>ids</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.milestones.getMilestoneStatuses(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Milestones.GetMilestoneStatusesError](src/resources/milestones.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.milestones.getMilestoneStatuses(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Milestones.GetMilestoneStatusesError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>reviewMilestone(request: Milestones.ReviewMilestoneRequest, options?: RequestOptions): ApiPromise&lt;ApiMilestonesReviewResponse2, Milestones.ReviewMilestoneError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Client only. approve (from review or needs_client) and confirm_partial (from needs_client) queue the release
job. veto (from review) and hold (from needs_client) move the milestone to held. Refused once the payout has
been claimed, after the window closed (veto and hold), or when a required criterion did not pass.

An agent may call it with a mandate token. Its approve is accepted only while the milestone is in review on the
policy's own release decision (P6) for the latest delivery, every required criterion passed and the amount is
within the mandate's cap; veto and hold need "hold" in the mandate; confirm_partial is never an agent's. Accepted
and refused agent calls are audited.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.milestones.reviewMilestone({
    id: "mst_1",
    body: { action: Action1.Approve },
  });
  // TODO: Handle 'response' of type ApiMilestonesReviewResponse2
} catch (err) {
  // TODO: Handle 'err' of type Milestones.ReviewMilestoneError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.milestones.reviewMilestone({
  id: "mst_1",
  body: { action: Action1.Approve },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiMilestonesReviewResponse2
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiMilestonesReviewRequest](src/models/api-milestones-review-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.milestones.reviewMilestone(request)`

- **OnSuccess**: <code>[ApiMilestonesReviewResponse2](src/models/unions/api-milestones-review-response2.ts)</code>
- **OnError**: throws <code>[Milestones.ReviewMilestoneError](src/resources/milestones.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.milestones.reviewMilestone(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiMilestonesReviewResponse2, Milestones.ReviewMilestoneError&gt;</code>, with `result.value` of type <code>[ApiMilestonesReviewResponse2](src/models/unions/api-milestones-review-response2.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Paypal

> Source: [Paypal](src/resources/paypal.ts)

<details>
<summary><code>getClientToken(options?: RequestOptions): ApiPromise&lt;ApiPaypalClientTokenResponse, ApiError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Returns a short-lived token the browser passes to the PayPal JS SDK v6 to render the PayPal button.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.paypal.getClientToken();
  // TODO: Handle 'response' of type ApiPaypalClientTokenResponse
} catch (err) {
  // TODO: Handle 'err' of type ApiError, where 'err.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.paypal.getClientToken().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiPaypalClientTokenResponse
} else {
  // TODO: Handle 'result', where 'result.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.paypal.getClientToken()`

- **OnSuccess**: <code>[ApiPaypalClientTokenResponse](src/models/api-paypal-client-token-response.ts)</code>
- **OnError**: throws <code>[ApiError](src/core/api-error.ts)</code>, with `err.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm

**As ApiResult**: `await client.paypal.getClientToken().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiPaypalClientTokenResponse, ApiError&gt;</code>, with `result.value` of type <code>[ApiPaypalClientTokenResponse](src/models/api-paypal-client-token-response.ts)</code>
- **OnError**: `result.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Webhooks

> Source: [Webhooks](src/resources/webhooks.ts)

<details>
<summary><code>receiveGitHubWebhook(request: Webhooks.ReceiveGitHubWebhookRequest, options?: RequestOptions): ApiPromise&lt;ApiWebhooksGithubResponse, Webhooks.ReceiveGitHubWebhookError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Verified with the X-Hub-Signature-256 HMAC against GITHUB_WEBHOOK_SECRET and stored once by
X-GitHub-Delivery. A merged pull request from a branch named m<seq>-... on a contract's repository creates a
delivery and a verify job. Everything else is ignored. With DEMO_MODE=1 a pull request whose clone_url is not
DEMO_REPO_URL is refused with 403 and a delivery.refused audit row; no delivery is stored and no job is queued.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.webhooks.receiveGitHubWebhook({
    xHubSignature256: "some example string",
    xGitHubDelivery: "some example string",
    xGitHubEvent: "pull_request",
    body: {},
  });
  // TODO: Handle 'response' of type ApiWebhooksGithubResponse
} catch (err) {
  // TODO: Handle 'err' of type Webhooks.ReceiveGitHubWebhookError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.webhooks.receiveGitHubWebhook({
  xHubSignature256: "some example string",
  xGitHubDelivery: "some example string",
  xGitHubEvent: "pull_request",
  body: {},
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiWebhooksGithubResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>xHubSignature256</code> | <code>string</code> | - |
| <code>xGitHubDelivery</code> | <code>string</code> | - |
| <code>xGitHubEvent</code> | <code>string</code> | - |
| <code>body</code> | <code>[GitHubPullRequestEvent](src/models/git-hub-pull-request-event.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.webhooks.receiveGitHubWebhook(request)`

- **OnSuccess**: <code>[ApiWebhooksGithubResponse](src/models/api-webhooks-github-response.ts)</code>
- **OnError**: throws <code>[Webhooks.ReceiveGitHubWebhookError](src/resources/webhooks.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.webhooks.receiveGitHubWebhook(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiWebhooksGithubResponse, Webhooks.ReceiveGitHubWebhookError&gt;</code>, with `result.value` of type <code>[ApiWebhooksGithubResponse](src/models/api-webhooks-github-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>receivePayPalWebhook(request: Webhooks.ReceivePayPalWebhookRequest, options?: RequestOptions): ApiPromise&lt;ApiWebhooksPaypalResponse, Webhooks.ReceivePayPalWebhookError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Verified with PayPal's verify-webhook-signature call against PAYPAL_WEBHOOK_ID, stored once by event id, then
routed. In PAYPAL_MODE=simulated the signature call is replaced by the X-Milestone-Simulated header (the shared
SIMULATED_WEBHOOK_SECRET, default "dev"), which the simulator sends itself about 1.5 seconds after a capture,
payout or refund. Handled events: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED,
PAYMENT.PAYOUTS-ITEM.* and PAYMENT.PAYOUTSBATCH.DENIED. Others are stored for the audit log. Returns 500
when an event is not processed yet so PayPal redelivers.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.webhooks.receivePayPalWebhook({
    body: { id: "some example string", eventType: "some example string", createTime: "some example string" },
  });
  // TODO: Handle 'response' of type ApiWebhooksPaypalResponse
} catch (err) {
  // TODO: Handle 'err' of type Webhooks.ReceivePayPalWebhookError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.webhooks.receivePayPalWebhook({
  body: { id: "some example string", eventType: "some example string", createTime: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiWebhooksPaypalResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>paypalTransmissionId?</code> | <code>string</code> | - |
| <code>paypalTransmissionTime?</code> | <code>string</code> | - |
| <code>paypalTransmissionSig?</code> | <code>string</code> | - |
| <code>paypalCertUrl?</code> | <code>string</code> | - |
| <code>paypalAuthAlgo?</code> | <code>string</code> | - |
| <code>body</code> | <code>[PayPalWebhookEvent](src/models/pay-pal-webhook-event.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.webhooks.receivePayPalWebhook(request)`

- **OnSuccess**: <code>[ApiWebhooksPaypalResponse](src/models/api-webhooks-paypal-response.ts)</code>
- **OnError**: throws <code>[Webhooks.ReceivePayPalWebhookError](src/resources/webhooks.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.webhooks.receivePayPalWebhook(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiWebhooksPaypalResponse, Webhooks.ReceivePayPalWebhookError&gt;</code>, with `result.value` of type <code>[ApiWebhooksPaypalResponse](src/models/api-webhooks-paypal-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Deliveries

> Source: [Deliveries](src/resources/deliveries.ts)

<details>
<summary><code>deliverRepository(request: Deliveries.DeliverRepositoryRequest, options?: RequestOptions): ApiPromise&lt;ApiMilestonesDeliverResponse, Deliveries.DeliverRepositoryError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only, while the milestone is funded or held. The ref (default HEAD) is resolved to a
commit with git ls-remote, a delivery with source `manual` is stored in the GitHub webhook's payload shape
(the baseline for the client's test suite is the milestone's funding-time sha), and a verify job is queued. The same
milestone and commit give the same delivery id, so a repeat returns `duplicate: true`. With DEMO_MODE=1 (the
hosted demo) only DEMO_REPO_URL is accepted (https, compared after normalising); any other repository, or every
repository when DEMO_REPO_URL is unset, gets 403 with `reason: demo_repo_only` and a delivery.refused audit row,
before ls-remote or a job. In DEMO_MODE the ref must also resolve to a branch or tag tip (or HEAD) of that
repository: a pull request head (refs/pull/N/head) or any other commit id is 422, nothing stored or queued.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.deliveries.deliverRepository({
    id: "mst_1",
    body: { repoUrl: "some example string" },
  });
  // TODO: Handle 'response' of type ApiMilestonesDeliverResponse
} catch (err) {
  // TODO: Handle 'err' of type Deliveries.DeliverRepositoryError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.deliveries.deliverRepository({
  id: "mst_1",
  body: { repoUrl: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiMilestonesDeliverResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>body</code> | <code>[ManualDeliveryRequest](src/models/manual-delivery-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.deliveries.deliverRepository(request)`

- **OnSuccess**: <code>[ApiMilestonesDeliverResponse](src/models/api-milestones-deliver-response.ts)</code>
- **OnError**: throws <code>[Deliveries.DeliverRepositoryError](src/resources/deliveries.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.deliveries.deliverRepository(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiMilestonesDeliverResponse, Deliveries.DeliverRepositoryError&gt;</code>, with `result.value` of type <code>[ApiMilestonesDeliverResponse](src/models/api-milestones-deliver-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>getDeliveredFile(request: Deliveries.GetDeliveredFileRequest, options?: RequestOptions): ApiPromise&lt;undefined, Deliveries.GetDeliveredFileError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Only the contract's client and freelancer. Served with a sandboxing Content-Security-Policy and nosniff;
images and PDFs open inline, everything else downloads as an attachment. The X-File-Sha256 header carries the
stored hash. Errors are plain text.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.deliveries.getDeliveredFile({
    deliveryId: "dlv_up_0123456789abcdef01234567",
    name: "logo.svg",
  });
} catch (err) {
  // TODO: Handle 'err' of type Deliveries.GetDeliveredFileError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.deliveries.getDeliveredFile({
  deliveryId: "dlv_up_0123456789abcdef01234567",
  name: "logo.svg",
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>deliveryId</code> | <code>string</code> | - |
| <code>name</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.deliveries.getDeliveredFile(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Deliveries.GetDeliveredFileError](src/resources/deliveries.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.deliveries.getDeliveredFile(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Deliveries.GetDeliveredFileError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>uploadFiles(request: Deliveries.UploadFilesRequest, options?: RequestOptions): ApiPromise&lt;ApiMilestonesUploadResponse, Deliveries.UploadFilesError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only, while the milestone is funded or held. Up to 10 files of 20 MB each, sent as
multipart field `files`, optional text field `note`. Files are stored under UPLOAD_DIR/<deliveryId>/ (default
var/uploads) with their sha256, a delivery with source `upload` is recorded, and a verify job runs the upload
checks (format by magic bytes, size, image dimensions, PDF page count, word count, required strings) and the
judgment stage. There is no baseline suite or gaming scan for uploads. Delivered files are untrusted evidence.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.deliveries.uploadFiles({ id: "mst_brand_1", files: new Uint8Array() });
  // TODO: Handle 'response' of type ApiMilestonesUploadResponse
} catch (err) {
  // TODO: Handle 'err' of type Deliveries.UploadFilesError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.deliveries.uploadFiles({
  id: "mst_brand_1",
  files: new Uint8Array(),
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiMilestonesUploadResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>files</code> | <code>FileInput</code> | A delivered file. The route reads every `files` field, so repeat the field to send up to 10 files in one delivery (described as one field because SDK generators do not support file arrays). |
| <code>note?</code> | <code>string</code> | Optional note to the reviewer |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.deliveries.uploadFiles(request)`

- **OnSuccess**: <code>[ApiMilestonesUploadResponse](src/models/api-milestones-upload-response.ts)</code>
- **OnError**: throws <code>[Deliveries.UploadFilesError](src/resources/deliveries.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.deliveries.uploadFiles(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiMilestonesUploadResponse, Deliveries.UploadFilesError&gt;</code>, with `result.value` of type <code>[ApiMilestonesUploadResponse](src/models/api-milestones-upload-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Advances

> Source: [Advances](src/resources/advances.ts)

<details>
<summary><code>acceptAdvance(request: Advances.AcceptAdvanceRequest, options?: RequestOptions): ApiPromise&lt;AdvanceAcceptResponse, Advances.AcceptAdvanceError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only. Under row locks the offer is re-priced from the database and stored as an
advance with status `offered`, `advance.accepted` is audited, and the `advance` job is queued; the job pays the
principal from the capital partner's PayPal account. One advance per milestone: a second call returns the
existing advance with 200 and `created: false`. The release repays the partner first (principal plus the quoted
fee) and pays the freelancer the rest.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.advances.acceptAdvance({ body: { milestoneId: "some example string" } });
  // TODO: Handle 'response' of type AdvanceAcceptResponse
} catch (err) {
  // TODO: Handle 'err' of type Advances.AcceptAdvanceError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.advances.acceptAdvance({
  body: { milestoneId: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type AdvanceAcceptResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>[ApiAdvancesAcceptRequest](src/models/api-advances-accept-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.advances.acceptAdvance(request)`

- **OnSuccess**: <code>[AdvanceAcceptResponse](src/models/advance-accept-response.ts)</code>
- **OnError**: throws <code>[Advances.AcceptAdvanceError](src/resources/advances.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.advances.acceptAdvance(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;AdvanceAcceptResponse, Advances.AcceptAdvanceError&gt;</code>, with `result.value` of type <code>[AdvanceAcceptResponse](src/models/advance-accept-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>getAdvanceOffer(request: Advances.GetAdvanceOfferRequest, options?: RequestOptions): ApiPromise&lt;AdvanceOfferResponse, Advances.GetAdvanceOfferError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only. If the milestone already has an advance (one per milestone) it is returned with
its stored offer. Otherwise a fresh offer is priced from the database; an ineligible milestone answers 200 with
`offer.eligible: false` and a reason. The explanation is two sentences from Claude when ANTHROPIC_API_KEY is set,
otherwise built from the numbers. The model never changes the numbers.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.advances.getAdvanceOffer({ milestoneId: "mst_1" });
  // TODO: Handle 'response' of type AdvanceOfferResponse
} catch (err) {
  // TODO: Handle 'err' of type Advances.GetAdvanceOfferError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.advances.getAdvanceOffer({ milestoneId: "mst_1" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type AdvanceOfferResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>milestoneId</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.advances.getAdvanceOffer(request)`

- **OnSuccess**: <code>[AdvanceOfferResponse](src/models/advance-offer-response.ts)</code>
- **OnError**: throws <code>[Advances.GetAdvanceOfferError](src/resources/advances.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.advances.getAdvanceOffer(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;AdvanceOfferResponse, Advances.GetAdvanceOfferError&gt;</code>, with `result.value` of type <code>[AdvanceOfferResponse](src/models/advance-offer-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Ops

> Source: [Ops](src/resources/ops.ts)

<details>
<summary><code>reconcileNow(options?: RequestOptions): ApiPromise&lt;undefined, Ops.ReconcileNowError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Partner or platform only; agents (any Authorization header) are refused. Queues the worker's reconcile job, which
reads list_transactions through PayPal's MCP server (read-only). A repeat inside the same minute is a no-op.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.ops.reconcileNow();
} catch (err) {
  // TODO: Handle 'err' of type Ops.ReconcileNowError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.ops.reconcileNow().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.ops.reconcileNow()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Ops.ReconcileNowError](src/resources/ops.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.ops.reconcileNow().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Ops.ReconcileNowError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>resolveAupReview(request: Ops.ResolveAupReviewRequest, options?: RequestOptions): ApiPromise&lt;ApiOpsAupResponse, Ops.ResolveAupReviewError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Partner or platform role only, and only while the contract's PayPal Acceptable Use Policy check is in review.
clear moves it to cleared (it can be signed and funded as usual; aup.cleared). reject is final (aup.rejected).
Moves no money.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.ops.resolveAupReview({
    contractId: "ctr_aup",
    body: { action: Action2.Clear, note: "some example string" },
  });
  // TODO: Handle 'response' of type ApiOpsAupResponse
} catch (err) {
  // TODO: Handle 'err' of type Ops.ResolveAupReviewError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.ops.resolveAupReview({
  contractId: "ctr_aup",
  body: { action: Action2.Clear, note: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiOpsAupResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>contractId</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiOpsAupRequest](src/models/api-ops-aup-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.ops.resolveAupReview(request)`

- **OnSuccess**: <code>[ApiOpsAupResponse](src/models/api-ops-aup-response.ts)</code>
- **OnError**: throws <code>[Ops.ResolveAupReviewError](src/resources/ops.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.ops.resolveAupReview(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiOpsAupResponse, Ops.ResolveAupReviewError&gt;</code>, with `result.value` of type <code>[ApiOpsAupResponse](src/models/api-ops-aup-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>resolveOperatorCase(request: Ops.ResolveOperatorCaseRequest, options?: RequestOptions): ApiPromise&lt;ApiOpsResolveResponse, Ops.ResolveOperatorCaseError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Partner or platform role only. Requires the latest operator event for the milestone to be
milestone.needs_operator. Writes an ops.resolved audit entry; it does not move money or change the status.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.ops.resolveOperatorCase({
    milestoneId: "some example string",
    body: { note: "some example string" },
  });
  // TODO: Handle 'response' of type ApiOpsResolveResponse
} catch (err) {
  // TODO: Handle 'err' of type Ops.ResolveOperatorCaseError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.ops.resolveOperatorCase({
  milestoneId: "some example string",
  body: { note: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiOpsResolveResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>milestoneId</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiOpsResolveRequest](src/models/api-ops-resolve-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.ops.resolveOperatorCase(request)`

- **OnSuccess**: <code>[ApiOpsResolveResponse](src/models/api-ops-resolve-response.ts)</code>
- **OnError**: throws <code>[Ops.ResolveOperatorCaseError](src/resources/ops.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.ops.resolveOperatorCase(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiOpsResolveResponse, Ops.ResolveOperatorCaseError&gt;</code>, with `result.value` of type <code>[ApiOpsResolveResponse](src/models/api-ops-resolve-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Disputes

> Source: [Disputes](src/resources/disputes.ts)

<details>
<summary><code>acceptDisputeClaim(request: Disputes.AcceptDisputeClaimRequest, options?: RequestOptions): ApiPromise&lt;undefined, Disputes.AcceptDisputeClaimError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only, and only once the milestone's money left escrow (else 409 milestone_not_final).
Without `confirm: true` nothing is sent. The refund moves through execute.ts, which books it in the ledger.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.disputes.acceptDisputeClaim({ id: "some example string", body: {} });
} catch (err) {
  // TODO: Handle 'err' of type Disputes.AcceptDisputeClaimError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.disputes.acceptDisputeClaim({
  id: "some example string",
  body: {},
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | Dispute id |
| <code>body</code> | <code>[ApiDisputesAcceptRequest](src/models/api-disputes-accept-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.disputes.acceptDisputeClaim(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Disputes.AcceptDisputeClaimError](src/resources/disputes.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.disputes.acceptDisputeClaim(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Disputes.AcceptDisputeClaimError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>submitDisputeEvidence(request: Disputes.SubmitDisputeEvidenceRequest, options?: RequestOptions): ApiPromise&lt;undefined, Disputes.SubmitDisputeEvidenceError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The contract's freelancer only. The delivered files go as documents when PayPal takes them. A double submit is answered once.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.disputes.submitDisputeEvidence({
    id: "some example string",
    body: { text: "some example string" },
  });
} catch (err) {
  // TODO: Handle 'err' of type Disputes.SubmitDisputeEvidenceError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.disputes.submitDisputeEvidence({
  id: "some example string",
  body: { text: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | Dispute id |
| <code>body</code> | <code>[ApiDisputesSubmitRequest](src/models/api-disputes-submit-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.disputes.submitDisputeEvidence(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Disputes.SubmitDisputeEvidenceError](src/resources/disputes.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.disputes.submitDisputeEvidence(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Disputes.SubmitDisputeEvidenceError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Agents

> Source: [Agents](src/resources/agents.ts)

<details>
<summary><code>agentConsoleTurn(request: Agents.AgentConsoleTurnRequest, options?: RequestOptions): ApiPromise&lt;undefined, Agents.AgentConsoleTurnError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The signed-in client names one of their mandates and supplies its token; the server runs Claude as an MCP client
of /api/mcp under that token (and of PayPal's MCP server, list_transactions only). Needs ANTHROPIC_API_KEY
(503 model_unavailable otherwise) and APP_URL or MILESTONE_MCP_URL.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.agentConsoleTurn({
    body: { mandateId: "some example string", token: "some example string", messages: [{}] },
  });
} catch (err) {
  // TODO: Handle 'err' of type Agents.AgentConsoleTurnError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.agentConsoleTurn({
  body: { mandateId: "some example string", token: "some example string", messages: [{}] },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>[ApiAgentsConsoleRequest](src/models/api-agents-console-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.agentConsoleTurn(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.AgentConsoleTurnError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.agentConsoleTurn(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.AgentConsoleTurnError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>createMandate(request: Agents.CreateMandateRequestParams, options?: RequestOptions): ApiPromise&lt;undefined, Agents.CreateMandateError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

People only. "approve" needs an approval cap; fund caps come in pairs and need "fund"; auto-fund needs both fund
caps. The token is stored as its sha256 and returned only here, with the MCP URL and header to use it.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.createMandate({
    body: { agentName: "some example string", actions: ["some example string"] },
  });
} catch (err) {
  // TODO: Handle 'err' of type Agents.CreateMandateError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.createMandate({
  body: { agentName: "some example string", actions: ["some example string"] },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>[CreateMandateRequest](src/models/create-mandate-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.createMandate(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.CreateMandateError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.createMandate(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.CreateMandateError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>listMandates(options?: RequestOptions): ApiPromise&lt;undefined, Agents.ListMandatesError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

People only; a request with an Authorization header is refused (403 agents_cannot_manage_mandates).

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.listMandates();
} catch (err) {
  // TODO: Handle 'err' of type Agents.ListMandatesError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.listMandates().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.listMandates()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.ListMandatesError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.listMandates().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.ListMandatesError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>mcpDelete(options?: RequestOptions): ApiPromise&lt;undefined, Agents.McpDeleteError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Not supported. The MCP server is stateless (Streamable HTTP without sessions), so DELETE answers 405.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.mcpDelete();
} catch (err) {
  // TODO: Handle 'err' of type Agents.McpDeleteError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.mcpDelete().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.mcpDelete()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.McpDeleteError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.mcpDelete().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.McpDeleteError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>mcpGet(options?: RequestOptions): ApiPromise&lt;undefined, Agents.McpGetError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Not supported. The MCP server is stateless (Streamable HTTP without sessions), so GET answers 405.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.mcpGet();
} catch (err) {
  // TODO: Handle 'err' of type Agents.McpGetError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.mcpGet().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.mcpGet()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.McpGetError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.mcpGet().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.McpGetError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>mcpPost(request: Agents.McpPostRequest, options?: RequestOptions): ApiPromise&lt;undefined, Agents.McpPostError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Authenticated by a mandate token; the agent acts as the mandate's user through the same routes a human uses, and
every call, refused ones included, is audited. Seven tools: list_contracts, get_milestone, get_ledger,
draft_contract, fund_milestone, deliver_milestone, respond_to_review. list_contracts carries each contract's
PayPal AUP check (aupCheck); fund_milestone refuses a contract whose check is not clear. See docs/mcp.md.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.mcpPost({ body: {} });
} catch (err) {
  // TODO: Handle 'err' of type Agents.McpPostError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.mcpPost({ body: {} }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>Record&lt;string, unknown&gt;</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.mcpPost(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.McpPostError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.mcpPost(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.McpPostError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>revokeMandate(request: Agents.RevokeMandateRequest, options?: RequestOptions): ApiPromise&lt;undefined, Agents.RevokeMandateError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

People only.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.revokeMandate({ id: "some example string" });
} catch (err) {
  // TODO: Handle 'err' of type Agents.RevokeMandateError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.revokeMandate({ id: "some example string" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.revokeMandate(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.RevokeMandateError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.revokeMandate(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.RevokeMandateError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>updateMandateFunding(request: Agents.UpdateMandateFundingRequest, options?: RequestOptions): ApiPromise&lt;undefined, Agents.UpdateMandateFundingError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

People only. Only fundCap, fundTotalCap (or their Minor forms) and autoFundNext can change; a key left out keeps
its value, null clears a cap. Actions, approval cap, currency and expiry never change: revoke and create anew.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.agents.updateMandateFunding({ id: "some example string", body: {} });
} catch (err) {
  // TODO: Handle 'err' of type Agents.UpdateMandateFundingError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.agents.updateMandateFunding({
  id: "some example string",
  body: {},
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id</code> | <code>string</code> | - |
| <code>body</code> | <code>[ApiAgentsRequest](src/models/api-agents-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.agents.updateMandateFunding(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Agents.UpdateMandateFundingError](src/resources/agents.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.agents.updateMandateFunding(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Agents.UpdateMandateFundingError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Vault

> Source: [Vault](src/resources/vault.ts)

<details>
<summary><code>getSavedPayPal(options?: RequestOptions): ApiPromise&lt;undefined, Vault.GetSavedPayPalError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The signed-in client's saved PayPal, or paymentMethod null when none is saved. Clients only; agents are refused.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.vault.getSavedPayPal();
} catch (err) {
  // TODO: Handle 'err' of type Vault.GetSavedPayPalError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.vault.getSavedPayPal().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.vault.getSavedPayPal()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Vault.GetSavedPayPalError](src/resources/vault.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.vault.getSavedPayPal().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Vault.GetSavedPayPalError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>removeSavedPayPal(request?: Vault.RemoveSavedPayPalRequest, options?: RequestOptions): ApiPromise&lt;undefined, Vault.RemoveSavedPayPalError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Clients only. { paymentMethodId } in the body or ?id=, else the current one. Idempotent.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.vault.removeSavedPayPal();
} catch (err) {
  // TODO: Handle 'err' of type Vault.RemoveSavedPayPalError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.vault.removeSavedPayPal().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>id?</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.vault.removeSavedPayPal(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Vault.RemoveSavedPayPalError](src/resources/vault.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.vault.removeSavedPayPal(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Vault.RemoveSavedPayPalError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>returnFromSavePayPal(request?: Vault.ReturnFromSavePayPalRequest, options?: RequestOptions): ApiPromise&lt;undefined, Vault.ReturnFromSavePayPalError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The setup token must belong to the signed-in user. Redirects to /agents?vault=<outcome>.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.vault.returnFromSavePayPal();
} catch (err) {
  // TODO: Handle 'err' of type Vault.ReturnFromSavePayPalError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.vault.returnFromSavePayPal().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>approvalTokenId?</code> | <code>string</code> | - |
| <code>cancelled?</code> | <code>string</code> | Set to 1 when the payer cancelled the approval |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.vault.returnFromSavePayPal(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Vault.ReturnFromSavePayPalError](src/resources/vault.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.vault.returnFromSavePayPal(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Vault.ReturnFromSavePayPalError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>startSavePayPal(options?: RequestOptions): ApiPromise&lt;ApiVaultStartResponse, Vault.StartSavePayPalError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Clients only; agents are refused. One saved PayPal at a time (409 already_saved). The browser goes to approveUrl.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.vault.startSavePayPal();
  // TODO: Handle 'response' of type ApiVaultStartResponse
} catch (err) {
  // TODO: Handle 'err' of type Vault.StartSavePayPalError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.vault.startSavePayPal().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiVaultStartResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.vault.startSavePayPal()`

- **OnSuccess**: <code>[ApiVaultStartResponse](src/models/api-vault-start-response.ts)</code>
- **OnError**: throws <code>[Vault.StartSavePayPalError](src/resources/vault.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.vault.startSavePayPal().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiVaultStartResponse, Vault.StartSavePayPalError&gt;</code>, with `result.value` of type <code>[ApiVaultStartResponse](src/models/api-vault-start-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Demo

> Source: [Demo](src/resources/demo.ts)

<details>
<summary><code>resetDemo(options?: RequestOptions): ApiPromise&lt;undefined, Demo.ResetDemoError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Exists only with DEMO_MODE=1 (404 otherwise). At most once every 30 s across all visitors (429 with
Retry-After). A form post (the demo band's Reset demo button) gets a 303 to home; a JSON caller gets { ok: true }.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.demo.resetDemo();
} catch (err) {
  // TODO: Handle 'err' of type Demo.ResetDemoError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.demo.resetDemo().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.demo.resetDemo()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Demo.ResetDemoError](src/resources/demo.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.demo.resetDemo().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Demo.ResetDemoError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Dev

> Source: [Dev](src/resources/dev.ts)

<details>
<summary><code>approveSimulatedOrder(request: Dev.ApproveSimulatedOrderRequest, options?: RequestOptions): ApiPromise&lt;undefined, Dev.ApproveSimulatedOrderError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Exists only while PAYPAL_MODE is simulated (404 otherwise). The approve link of a simulated order points here. It
marks the order APPROVED and redirects (303) to /contracts/{contractId}?approved=<orderId>&milestone=<id>, where
the fund button captures it.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.dev.approveSimulatedOrder({ order: "some example string" });
} catch (err) {
  // TODO: Handle 'err' of type Dev.ApproveSimulatedOrderError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.approveSimulatedOrder({ order: "some example string" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>order</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.approveSimulatedOrder(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Dev.ApproveSimulatedOrderError](src/resources/dev.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.dev.approveSimulatedOrder(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Dev.ApproveSimulatedOrderError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>approveSimulatedVaultSetup(request: Dev.ApproveSimulatedVaultSetupRequest, options?: RequestOptions): ApiPromise&lt;undefined, Dev.ApproveSimulatedVaultSetupError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Exists only while PAYPAL_MODE is simulated (404 otherwise). Marks the setup token approved and redirects to its
return_url (only one on this app) with ?approval_token_id=<id>.


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.dev.approveSimulatedVaultSetup({ token: "some example string" });
} catch (err) {
  // TODO: Handle 'err' of type Dev.ApproveSimulatedVaultSetupError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.approveSimulatedVaultSetup({ token: "some example string" }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>token</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.approveSimulatedVaultSetup(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Dev.ApproveSimulatedVaultSetupError](src/resources/dev.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.dev.approveSimulatedVaultSetup(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Dev.ApproveSimulatedVaultSetupError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>armSimulatedPayoutFailure(request?: Dev.ArmSimulatedPayoutFailureRequest, options?: RequestOptions): ApiPromise&lt;ApiDevPaypalFailResponse, Dev.ArmSimulatedPayoutFailureError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Exists only while PAYPAL_MODE is simulated (404 otherwise). Arms a one-shot failure: the next payout item with
this sender_item_id comes back FAILED, so the release goes to `held` with `milestone.needs_operator`. Release
items use `<milestoneId>:freelancer` and `<milestoneId>:partner`. Accepts JSON, or a form post (the /ops
"Simulate payout failure" button).


</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.dev.armSimulatedPayoutFailure({
    senderItemId: "mst_1:freelancer",
    reason: "RECEIVER_UNREGISTERED",
  });
  // TODO: Handle 'response' of type ApiDevPaypalFailResponse
} catch (err) {
  // TODO: Handle 'err' of type Dev.ArmSimulatedPayoutFailureError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.armSimulatedPayoutFailure({
  senderItemId: "mst_1:freelancer",
  reason: "RECEIVER_UNREGISTERED",
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiDevPaypalFailResponse
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>senderItemId?</code> | <code>string</code> | - |
| <code>milestoneId?</code> | <code>string</code> | - |
| <code>party?</code> | <code>[Party](src/models/party.ts)</code> | -<br>**Default**: "freelancer" |
| <code>reason?</code> | <code>string</code> | A PayPal error name<br>**Default**: "RECEIVER_ACCOUNT_LOCKED" |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.armSimulatedPayoutFailure(request)`

- **OnSuccess**: <code>[ApiDevPaypalFailResponse](src/models/api-dev-paypal-fail-response.ts)</code>
- **OnError**: throws <code>[Dev.ArmSimulatedPayoutFailureError](src/resources/dev.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.dev.armSimulatedPayoutFailure(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiDevPaypalFailResponse, Dev.ArmSimulatedPayoutFailureError&gt;</code>, with `result.value` of type <code>[ApiDevPaypalFailResponse](src/models/api-dev-paypal-fail-response.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>getPayPalMode(options?: RequestOptions): ApiPromise&lt;ApiDevPaypalModeResponse, ApiError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Answers in every mode. The fund button asks when it was not told.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.dev.getPayPalMode();
  // TODO: Handle 'response' of type ApiDevPaypalModeResponse
} catch (err) {
  // TODO: Handle 'err' of type ApiError, where 'err.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.getPayPalMode().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiDevPaypalModeResponse
} else {
  // TODO: Handle 'result', where 'result.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.getPayPalMode()`

- **OnSuccess**: <code>[ApiDevPaypalModeResponse](src/models/api-dev-paypal-mode-response.ts)</code>
- **OnError**: throws <code>[ApiError](src/core/api-error.ts)</code>, with `err.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm

**As ApiResult**: `await client.dev.getPayPalMode().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiDevPaypalModeResponse, ApiError&gt;</code>, with `result.value` of type <code>[ApiDevPaypalModeResponse](src/models/api-dev-paypal-mode-response.ts)</code>
- **OnError**: `result.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>listArmedFailures(options?: RequestOptions): ApiPromise&lt;ApiDevPaypalFailResponse1, Dev.ListArmedFailuresError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Simulated PayPal only. Lists the payout failures armed for the next payouts, used to demonstrate a held release.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.dev.listArmedFailures();
  // TODO: Handle 'response' of type ApiDevPaypalFailResponse1
} catch (err) {
  // TODO: Handle 'err' of type Dev.ListArmedFailuresError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.listArmedFailures().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ApiDevPaypalFailResponse1
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.listArmedFailures()`

- **OnSuccess**: <code>[ApiDevPaypalFailResponse1](src/models/api-dev-paypal-fail-response1.ts)</code>
- **OnError**: throws <code>[Dev.ListArmedFailuresError](src/resources/dev.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.dev.listArmedFailures().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ApiDevPaypalFailResponse1, Dev.ListArmedFailuresError&gt;</code>, with `result.value` of type <code>[ApiDevPaypalFailResponse1](src/models/api-dev-paypal-fail-response1.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>openSimulatedDispute(request: Dev.OpenSimulatedDisputeRequest, options?: RequestOptions): ApiPromise&lt;undefined, Dev.OpenSimulatedDisputeError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Simulated PayPal only. The simulator then sends CUSTOMER.DISPUTE.CREATED to the PayPal webhook. JSON or form body.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.dev.openSimulatedDispute({ body: { milestoneId: "some example string" } });
} catch (err) {
  // TODO: Handle 'err' of type Dev.OpenSimulatedDisputeError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.dev.openSimulatedDispute({
  body: { milestoneId: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>[ApiDisputesDevRequest](src/models/api-disputes-dev-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.dev.openSimulatedDispute(request)`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Dev.OpenSimulatedDisputeError](src/resources/dev.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.dev.openSimulatedDispute(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Dev.OpenSimulatedDisputeError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[MilestoneApiError](src/core/errors.ts)</code> on any operational failure — a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

