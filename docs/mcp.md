# Milestone MCP server

Milestone exposes an MCP server so that an AI agent (Claude Desktop, Cursor, or any MCP client) can work on escrowed
milestones for a user. The agent works under a mandate. A mandate lists the actions the user allows, sets an approval
cap in minor units, optional fund caps, has an expiry date, and can be revoked at any time. Every call goes through the same routes and
policy a human uses, and each one is written to the audit log with the actor `agent:<agentName> for <userId>`.

## The guarantee

An agent can only make a release happen sooner. It can never make a release happen that the policy would not make.

`respond_to_review` with `"approve"` is accepted from an agent only when all of these hold:

- the milestone is in `review`;
- the stored decision is the policy's own release decision (rule P6), made for the milestone's latest delivery;
- every required criterion passed;
- the amount, `max(milestone amount, decision amount)`, is in the mandate's currency and within its approval cap;
- the mandate has not expired, has not been revoked, and includes `approve`.

The review route (`POST /api/milestones/[id]/review`) enforces these conditions, and it is the only place they are
enforced. The MCP tool forwards the agent's bearer token to that route. If the agent does nothing, the release still
happens when the review window closes, so an approve only brings it forward.

## The funding guarantee

An agent can fund only a milestone the contract's parties agreed to, and only within the limits the user set. The
`fund_milestone` tool (and the auto-fund rule, below) may charge the client's saved PayPal only when all of these hold:

- the contract is active and both parties approved it;
- the milestone is in `draft`, and is the next unfunded milestone in sequence;
- the charge is exactly the milestone amount, in the mandate's currency;
- the amount is within the mandate's per-milestone fund cap (`fundCapMinor`), and the total the mandate has funded
  over its life, this charge included, is within its total fund cap (`fundTotalCapMinor`); a mandate without both caps
  cannot fund from the vault;
- the mandate is unexpired, unrevoked and includes `fund`;
- the saved PayPal payment token belongs to the mandate's user and has not been removed;
- no capture of the milestone is in progress.

One function, `fundFromVault` in `packages/money/src/policy/execute.ts`, checks all of it (`fundingAllows` in
`packages/core/src/mandates.ts` is the pure check; the sum already funded and the rows it reads are locked inside the
transaction, so two calls cannot both squeeze under a cap). The vault charge, `chargeVault` in
`packages/money/src/paypal/money.ts`, is reachable only from `execute.ts` (`pnpm check:boundaries`). Every charge is
a `paypal_ops` row first (`vault_charge`), so a retry sends the same `PayPal-Request-Id` and cannot charge twice. Money
lands in the platform account exactly as a human payment does, and the release rules do not change. Calls and refusals
are audited as `agent:<name> for <user>`; a refusal writes `vault.fund_refused` with its reason. Calling
`fund_milestone` again on a milestone this mandate already funded answers `{ funded: true, already: true }` and charges
nothing; any other mandate gets `milestone_not_draft`. While an agent's charge for a milestone is in flight, the
client's own checkout capture of it is refused (409), so the client is never charged twice for one milestone.

Note that the guarantee bounds funding, not timing: an agent (or a model told to "fund everything") can fund each next
milestone in turn before earlier ones are delivered, up to the total fund cap. The total cap is what limits it.

Refusal reasons, in check order: `mandate_revoked`, `mandate_expired`, `mandate_missing_action`,
`payment_method_missing`, `payment_method_not_owned`, `payment_method_removed`, `not_contract_client`,
`contract_not_approved`, `milestone_not_in_contract`, `milestone_not_draft`, `capture_in_progress`, `out_of_sequence`,
`amount_mismatch`, `currency_mismatch`, `fund_cap_missing`, `fund_cap_exceeded`, `fund_total_cap_exceeded`.

### Auto-fund the next milestone

A mandate created with `autoFundNext: true` (it needs the `fund` action and both caps) lets the platform do what the
agent would do: when a milestone reaches `released`, the settle job enqueues an `autofund` job for the contract's next
draft milestone, which calls the same `fundFromVault` with the same guarantee, acting as the client's newest live
mandate with auto-fund. It funds exactly the milestone it was enqueued for, never whatever is next by then. No model is
involved. Each run writes one `agent.autofund` audit row; a refusal is final and leaves the milestone in `draft` for
the client to fund by hand.

### Saving a PayPal

The client saves a PayPal once (PayPal Payment Method Tokens v3): Milestone creates a setup token (`POST /api/vault/start`), the client
approves it at PayPal and returns to `/api/vault/return`, and Milestone exchanges it for a payment token that it stores
(the `payment_methods` table; `DELETE /api/vault` removes it). The Saved PayPal card on `/agents` does this.
Only the client can, from the signed-in session; requests with an `Authorization` header are refused, so an
agent can neither save nor remove a PayPal. Removing it deletes the PayPal payment token, and funding stops at once.
In production, charging a saved PayPal without the buyer present needs PayPal's approval for reference transactions
on the merchant account; the sandbox and the simulator need none.

No agent path pays out or refunds, and the only charge is the one above. PayPal's own money-moving MCP tools
(`pay_order`, `create_refund`, `accept_dispute_claim`, any capture or payout) are never exposed to a model.

Text written by the freelancer appears only inside a field named `untrusted`, together with a warning and
`<<<UNTRUSTED>>>` / `<<<END UNTRUSTED>>>` markers. This covers verdict rationales, commit titles and bodies, delivery
refs and evidence summaries. It is evidence, never instructions (CLAUDE.md rule 5).

## Endpoint

`POST /api/mcp` uses Streamable HTTP, stateless, with JSON responses.

- Every request must carry `Authorization: Bearer msa_...`. There is no cookie fallback.
- `401 invalid_token`: the header is missing, malformed or unknown. The response includes `WWW-Authenticate: Bearer`.
- `403 mandate_expired` / `403 mandate_revoked`: the token is known but its mandate is no longer live.
- `GET` and `DELETE` return 405, because there are no sessions or server-sent event streams.

Each request authenticates again, so a revoke takes effect on the agent's next call.

## Getting a token

Mandates belong to the signed-in user, which in the demo is the user picked by the role-cookie switcher. Requests that
carry an `Authorization` header are refused (403), so an agent can never create or change mandates.

```sh
# create (the token is in this response only; it is stored as its sha256)
curl -X POST http://localhost:3000/api/agents -H 'cookie: milestone_actor=usr_client' -H 'content-type: application/json' \
  -d '{"agentName":"Casey'"'"'s agent","actions":["read","fund","approve","hold"],"approveCap":"200.00","fundCap":"200.00","fundTotalCap":"200.00","autoFundNext":true,"currency":"USD","expiresInDays":30}'
# list (never shows tokens)
curl http://localhost:3000/api/agents -H 'cookie: milestone_actor=usr_client'
# revoke (idempotent)
curl -X POST http://localhost:3000/api/agents/<mandateId>/revoke -H 'cookie: milestone_actor=usr_client'
```

Each role can delegate these actions:

- client: `read`, `draft_contract`, `fund`, `approve`, `hold`
- freelancer: `read`, `deliver`
- partner: `read`

`approve` requires a cap (`approveCap` as a decimal string, or `approveCapMinor`). `fund` charges a saved PayPal only with a per-milestone fund cap (`fundCap` or `fundCapMinor`) and a total fund cap over the mandate's life (`fundTotalCap` or `fundTotalCapMinor`); without them `fund_milestone` only returns an approval link for a human and never charges. `autoFundNext` needs `fund` and both caps. A mandate lasts at most 90 days.

`pnpm db:seed -- --reset --showcase` also prints a token for the showcase mandate `mdt_show_casey`. That mandate belongs
to Casey Client and allows read, draft_contract, fund, approve and hold, with approvals up to 200.00 USD, for 30 days.

## Tools

| Tool | Mandate action | Input | What it does |
| --- | --- | --- | --- |
| `list_contracts` | `read` | `{}` | Lists the user's contracts (as client or freelancer) with each milestone's id, title, amount and status. |
| `get_milestone` | `read` | `{ milestoneId }` | Returns the status, amount and criteria; the latest verdict per criterion (status, confidence, evidence ids); the decision and its rule; the seconds left in the review window; and `agentApproval { allowedNow, blockedBy[] }`. Freelancer text is in `untrusted`. |
| `get_ledger` | `read` | `{ contractId }` | Returns the contract's ledger transactions with their legs, the escrow held per milestone, totals by kind, and whether every transaction balances. |
| `draft_contract` | `draft_contract` (client) | `{ scope, total: "1500.00", currency: "USD", repo?: "owner/name", title? }` | Calls `POST /api/contracts`, which runs `compileContract` the same way the New contract form does. The result is a draft that both parties must approve in the UI. |
| `fund_milestone` | `fund` (client) | `{ milestoneId }` | With a saved PayPal and fund caps on the mandate, charges the saved PayPal under the funding guarantee and returns `{ funded: true, captureId, amount, remainingTotalCap }` (`pending: true` when PayPal has not completed the capture; the milestone turns funded when it does). Without a saved PayPal or fund caps it creates the PayPal order via `POST /api/milestones/[id]/order` and returns `{ orderId, approvalUrl }` with `vault.why`; a human approves the payment, and the tool never captures. Refused with a reason when the guarantee does not hold. |
| `deliver_milestone` | `deliver` (freelancer) | `{ milestoneId, repoUrl, ref?, title?, note? }` | Calls `POST /api/milestones/[id]/deliver`, with the same ref checks and the same local-repository gate. |
| `respond_to_review` | `approve` / `hold` (client) | `{ milestoneId, action: "approve" \| "hold" }` | Calls `POST /api/milestones/[id]/review` with the agent's token. `hold` becomes a veto while the milestone is in review, and a hold while the client is being asked. |

Refusals come back as tool errors with `{ ok: false, error, reason, ... }`:

- mandate refusals: `mandate_missing_action`, `mandate_cap_exceeded` (with `amountMinor`, `capMinor`, `currency`, `mandateCurrency`), `mandate_expired`, `mandate_revoked`;
- funding refusals (the reasons listed under the funding guarantee, plus `paypal_error` with `retryable` when PayPal fails the charge, `paypal_not_completed`, `capture_mismatch` and `rejected`);
- the review route's refusals: `not_release_decision`, `required_criteria_not_passed` (with `criteria`), `payout_sent`, `needs_operator`, `review_window_closed`;
- other refusals: `wrong_role`, `not_found`, `invalid_arguments`, `identity_unbound`, and `route_refused` with the route's HTTP `status`.

Every refusal is audited. The review route writes `agent.<action>_refused`, and the other tools write `agent.<tool>_refused`.

## Claude Desktop

Claude Desktop launches local commands, so use the stdio bridge `scripts/milestone-mcp.mjs`. The bridge forwards
messages to the HTTP endpoint and adds nothing of its own. It sends the token only over https, or over http to
localhost. Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "milestone": {
      "command": "node",
      "args": ["/absolute/path/to/milestone/scripts/milestone-mcp.mjs"],
      "env": { "MILESTONE_URL": "http://localhost:3000", "MILESTONE_AGENT_TOKEN": "msa_..." }
    }
  }
}
```

## Cursor

In `.cursor/mcp.json` (or `~/.cursor/mcp.json`), you can connect directly over HTTP:

```json
{
  "mcpServers": {
    "milestone": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer msa_..." }
    }
  }
}
```

Or you can use the stdio bridge, with the same `command`, `args` and `env` as in the Claude Desktop config above.

## How the tools reach the routes

The tools call the route handlers in-process (`src/lib/mcp/routes.ts`), so none of the routes' logic is copied.

- The review route resolves the agent from the forwarded bearer token itself.
- The contracts, order and deliver routes still take their caller from the role cookie (`getActor()`). For the length of
  the MCP request, `/api/mcp` binds that cookie to the mandate's user, and puts it back afterwards. Before each call, a
  check confirms the binding holds, and the call fails closed if it does not. Because `getActor()` only knows the three
  demo identities, these three tools refuse with `identity_unbound` for any other user, such as `usr_client2`.
- Those three routes write their own audit rows with the user id. The MCP layer adds an `agent.<tool>` row with the
  agent actor alongside.

## Tests

`apps/web/test/mcp.test.ts` runs a real MCP client against `/api/mcp` in-process, calling every tool and covering its
refusals. It runs against a scratch database:

```sh
MILESTONE_E2E=1 DATABASE_URL=postgres://.../<scratch> pnpm --filter @milestone/web exec vitest run test/mcp.test.ts
```
