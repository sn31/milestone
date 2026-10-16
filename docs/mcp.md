# Milestone MCP server

Milestone exposes an MCP server so that an AI agent (Claude Desktop, Cursor, or any MCP client) can work on escrowed
milestones for a user. The agent works under a mandate. A mandate lists the actions the user allows, sets an approval
cap in minor units, has an expiry date, and can be revoked at any time. Every call goes through the same routes and
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

No agent path moves money directly. No tool captures, pays out or refunds. `fund_milestone` creates the PayPal order
and returns the approval link, and a human approves the payment in PayPal. PayPal's own money-moving MCP tools
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
  -d '{"agentName":"Casey'"'"'s agent","actions":["read","fund","approve","hold"],"approveCap":"200.00","currency":"USD","expiresInDays":30}'
# list (never shows tokens)
curl http://localhost:3000/api/agents -H 'cookie: milestone_actor=usr_client'
# revoke (idempotent)
curl -X POST http://localhost:3000/api/agents/<mandateId>/revoke -H 'cookie: milestone_actor=usr_client'
```

Each role can delegate these actions:

- client: `read`, `draft_contract`, `fund`, `approve`, `hold`
- freelancer: `read`, `deliver`
- partner: `read`

`approve` requires a cap (`approveCap` as a decimal string, or `approveCapMinor`). A mandate lasts at most 90 days.

`pnpm db:seed -- --reset --showcase` also prints a token for the showcase mandate `mdt_show_casey`. That mandate belongs
to Casey Client and allows read, draft_contract, fund, approve and hold, with approvals up to 200.00 USD, for 30 days.

## Tools

| Tool | Mandate action | Input | What it does |
| --- | --- | --- | --- |
| `list_contracts` | `read` | `{}` | Lists the user's contracts (as client or freelancer) with each milestone's id, title, amount and status. |
| `get_milestone` | `read` | `{ milestoneId }` | Returns the status, amount and criteria; the latest verdict per criterion (status, confidence, evidence ids); the decision and its rule; the seconds left in the review window; and `agentApproval { allowedNow, blockedBy[] }`. Freelancer text is in `untrusted`. |
| `get_ledger` | `read` | `{ contractId }` | Returns the contract's ledger transactions with their legs, the escrow held per milestone, totals by kind, and whether every transaction balances. |
| `draft_contract` | `draft_contract` (client) | `{ scope, total: "1500.00", currency: "USD", repo?: "owner/name", title? }` | Calls `POST /api/contracts`, which runs `compileContract` the same way the New contract form does. The result is a draft that both parties must approve in the UI. |
| `fund_milestone` | `fund` (client) | `{ milestoneId }` | Calls `POST /api/milestones/[id]/order` and returns `{ orderId, approvalUrl }`. A human approves the payment in PayPal. The tool never captures. |
| `deliver_milestone` | `deliver` (freelancer) | `{ milestoneId, repoUrl, ref?, title?, note? }` | Calls `POST /api/milestones/[id]/deliver`, with the same ref checks and the same local-repository gate. |
| `respond_to_review` | `approve` / `hold` (client) | `{ milestoneId, action: "approve" \| "hold" }` | Calls `POST /api/milestones/[id]/review` with the agent's token. `hold` becomes a veto while the milestone is in review, and a hold while the client is being asked. |

Refusals come back as tool errors with `{ ok: false, error, reason, ... }`:

- mandate refusals: `mandate_missing_action`, `mandate_cap_exceeded` (with `amountMinor`, `capMinor`, `currency`, `mandateCurrency`), `mandate_expired`, `mandate_revoked`;
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
