# Milestone

Freelance pay runs on trust: in one survey of 3,300 freelancers, 85% are paid late at least some of the time ([Remote, 2025](https://assets.ctfassets.net/8naaccf28y0f/7llxHUuxPx38PzrA1lMdES/03a2a0b9c85384fb9b4471e16426f02d/The_State_of_Freelance_Work_2025.pdf)), and clients release escrow on a click or a timer, not a check of the work. Milestone is escrow for freelance developers and designers and the small businesses that hire them: it holds the client's PayPal payment, grades each delivery with the client's own tests, measured file checks and Claude's cited judgment, and pays out by itself only when a fixed policy finds every check passed; otherwise it holds the money or asks the client. Claude judges the work but never decides, PayPal's webhook confirms every payout, and the client's AI agents act only within the limits the client set.

PayPal holds and moves every dollar: the client pays through PayPal Checkout or from a PayPal saved once, the funds wait in the platform account, and PayPal Payouts pays the freelancer, with a refund of the rest when only part of the work passed. Judgment criteria are judged by Claude (`claude-sonnet-5-5` by default) through the Anthropic SDK when `ANTHROPIC_API_KEY` is set. A client can hand bounded actions to an AI agent (Claude Desktop, Cursor, or the built-in console) through Milestone's MCP server: it funds only the next milestone within the mandate's caps, and can only make a release happen sooner, never one the policy would not.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). [The hosted demo](#try-the-hosted-demo) runs on the real PayPal sandbox: you fund milestones through PayPal's own sandbox checkout with a sandbox buyer account, and payouts, refunds, advances and webhooks are PayPal's. Locally it runs with no keys on a built-in PayPal simulator that answers the same REST calls and posts its own webhooks, or on your own sandbox app. The money route was first proved against the sandbox on Nov 5 (capture, payout, a retried payout that did not pay twice, and a partial payout plus refund: `fixtures/paypal-recordings/spike-2026-11-05.json`).

## Try the hosted demo

**https://milestone-amov.onrender.com** runs on the real PayPal sandbox with Claude judging. There is no sign-in: the role switcher at the top right picks who you are (client **Casey**, freelancer **Frankie** or capital partner **Parker**; see [Demo roles](#demo-roles)). The first page load can take a little while.

1. As **client**, open "Signup flow for a SaaS landing page" and pay milestone 1 with PayPal's button. Log in with the sandbox buyer account; its email and password are in the Devpost submission's testing instructions. The milestone turns Funded.
2. As **freelancer**, deliver milestone 1 from the demo repository **https://github.com/sn31/landing**, branch `m1-pass`. Watch the verifying log: the client's own test suite grades the delivered code, then Claude judges the rest and must cite evidence. Open the receipt to see each verdict's evidence and the policy rule that decided the release.
3. As **client**, approve inside the review window. The milestone turns Released when PayPal's payout webhook confirms the payout, usually within a minute or two.
4. Fund milestone 2, then deliver `m2-partial` (the client's annual-discount test fails, so the money stays held) or `m2-injection` (a commit message that tries to instruct the reviewer is flagged and sent to the client).
5. As **partner**, see the lender's book at `/lender` and the operator queue at `/ops`. **Reset demo** in the banner restores the starting data; PayPal's sandbox keeps its own history.

The other contracts show every milestone state at once. They were recorded for the showcase and are display only; the signup-flow contract is the live path. The hosted demo accepts code deliveries only from the demo repository, because delivered code is not sandboxed (see the known limitation under [Structure](#structure)).

## Quick start

Runs locally with **no PayPal account and no API keys**: a built-in PayPal simulator answers the same REST calls and posts its own webhooks, and without an Anthropic key the judgment criteria go to the client to decide. With your own PayPal sandbox app, `PAYPAL_MODE=sandbox` runs the same app on the real sandbox (see the notes below). The hosted demo is the real sandbox already; `docs/deploy.md` describes it.

**Prerequisites**

- Node.js 24 or later (`node -v`)
- pnpm 12 (`corepack enable` picks up the version pinned in `package.json`; or `npm i -g pnpm@12`)
- git, and a POSIX shell (macOS or Linux; on Windows use WSL)
- Postgres 15 or later: Docker (Docker Desktop running) for the bundled Postgres 17, or a Postgres you already have
- The first `pnpm install` downloads about 650 packages, which takes a few minutes on a cold machine.

**1. Get the code and install**

```bash
git clone https://github.com/sn31/milestone.git && cd milestone
pnpm install
cp .env.example .env          # leave every key blank: PAYPAL_MODE=simulated, no model
```

**2. Start Postgres** (pick one)

```bash
docker compose up -d          # Postgres 17 on :5432, user/password/database all "milestone"
```

If :5432 is already taken, put `POSTGRES_PORT=5433` in `.env`, change `DATABASE_URL` in `.env` to `localhost:5433`, then run `docker compose up -d`.

With your own Postgres instead of Docker:

```bash
createuser -P milestone       # password: milestone
createdb -O milestone milestone
```

and point `DATABASE_URL` in `.env` at it if the host, port or name differ. Every command below (migrate, seed, web, worker) reads `DATABASE_URL` from `.env`; a value exported in your shell takes precedence.

**3. Create the schema and the demo data, then run**

```bash
pnpm db:migrate
pnpm db:seed                  # 5 users, 3 contracts, 7 milestones
pnpm dev                      # web on http://localhost:3000 and the worker, in one terminal; Ctrl-C stops both
```

Wait for `worker up: verify, release, settle, advance, ...` and Next.js's `Ready`, then open **http://localhost:3000**. The role switcher at the top right picks who you are (there is no sign-in): client **Casey**, freelancer **Frankie** or capital partner **Parker** (see [Demo roles](#demo-roles)). Then follow the [Ten-minute tour](#ten-minute-tour).

**Reset**

- `pnpm db:reset` empties every table, deletes the simulator's state (`var/simulated-paypal.json`) and uploads, and seeds again. Stop `pnpm dev` first and start it again after.
- `pnpm db:seed -- --reset --showcase` re-seeds with every milestone state on screen at once (tour step 7).

Notes:
- `PAYPAL_MODE=simulated` is the no-credentials path: a local simulator stands in for PayPal, shares its state between web and worker in `var/simulated-paypal.json` and posts its own webhooks. For the real sandbox set `PAYPAL_MODE=sandbox` with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and the partner app's credentials; see `docs/runbook.md`. Locally, PayPal's payout webhook cannot reach `localhost`, so a release stays at "releasing"; the hosted demo receives it and shows Released. On the sandbox the showcase's other states are recorded with simulator ids and marked "recorded for the showcase" (display only); the signup-flow contract is the live path.
- A model is optional. It judges judgment criteria, compiles a scope into a contract, phrases advance explanations and drives the agent console: set `ANTHROPIC_API_KEY` in `.env` for Claude (restart `pnpm dev`). Without a key the contract form builds a fixed three-milestone demo contract titled from the scope's first sentence, and a delivery that passes every checkable criterion goes to "needs client" instead of the review window, because the judgment criteria stay unclear.
- In simulated mode the seed gives the freelancer and partner test payout receivers, so releases and advances work with no setup. For the real sandbox, set `PAYPAL_FREELANCER_EMAIL` and `PAYPAL_PARTNER_EMAIL` (sandbox accounts) before `pnpm db:seed`.
- Build the demo repository with `scripts/make-demo-repo.sh <dir>`. Its branches are `m1-pass` (the signup form's password field and validation; all tests pass), `m2-partial` (a pricing page; the client's annual-discount test fails against it, so the milestone is held) and `m2-injection` (same code, commit message tries to instruct the reviewer; flagged). Deliver a branch from the milestone's Deliver form (repository path and branch) or by merging a pull request with the GitHub webhook set up.
- Check everything with `pnpm typecheck`, `pnpm test` and `pnpm check:boundaries`. Postgres-backed end-to-end suites are opt-in with `MILESTONE_E2E=1 pnpm test` (seed first).

## Ten-minute tour

The fastest way to see what Milestone is. Set `REVIEW_WINDOW_SECONDS=120` in `.env` so review windows run at demo pace, **before** `pnpm dev` (if it is already running, stop it with Ctrl-C and start it again).

1. `scripts/make-demo-repo.sh /tmp/milestone-demo` builds the demo repository and its three delivery branches.
2. As **client** (role switcher, top right), open the signup-flow contract and fund milestone 1. In simulated mode the PayPal checkout is one click.
3. As **freelancer**, deliver milestone 1: repository `/tmp/milestone-demo`, branch `m1-pass`. Watch the verifying log: the client's own test suite is restored over the delivery and grades it, then (with `ANTHROPIC_API_KEY` set) Claude judges the rest and must cite evidence. Open the receipt: every verdict cites its evidence, and the release stamp names the policy rule, not the model.
4. As client, approve inside the review window. The milestone is released only when PayPal's (simulated) webhook confirms the payout; the contract ledger shows every entry summing to zero.
5. Fund milestone 2, then deliver `m2-partial`: the client's own annual-discount test fails against the delivered pricing code, and the money stays held. Deliver `m2-injection`: the commit message that tries to instruct the reviewer is struck through as untrusted evidence, flagged, and sent to the client.
6. `/agents` as client: save a PayPal once, create a mandate with caps, and connect an MCP client or the built-in console ([Agent quick start](#agent-quick-start) below). Every agent call, refused ones included, lands in the audit log.
7. `pnpm db:seed -- --reset --showcase` re-seeds with every milestone state at once: advances and the lender's book at `/lender`, an operator case at `/ops`, and a ready-made mandate whose token it prints.

## Demo roles

The role switcher in the header sets a cookie. There is no sign-in; this is a demo stand-in.

- client (Casey): approves contracts, funds milestones, approves, vetoes or confirms partial releases.
- freelancer (Frankie): approves contracts, delivers (merged pull request, a commit, or uploaded files) and takes advances.
- partner (Parker): the capital partner and operator; sees the lender's book at `/lender` and resolves cases at `/ops`.

Driving the API by hand (curl, Postman): send the cookie `milestone_actor=usr_client`, `usr_freelancer` or `usr_partner`; with no cookie you are the client.

Seed data: three active contracts. "Signup flow for a SaaS landing page" (`ctr_demo`) has three milestones of $100 that match the demo repo branches. "Brand refresh for a bakery" (`ctr_brand`) has two milestones whose criteria are uploaded files (logo, PDF style guide, website copy). "Analytics dashboard" (`ctr_dash`) is a second client's (Dana) small contract so the lender's book has two clients. `pnpm db:seed -- --showcase` places every milestone in a different state.

## Agent quick start

1. Run the app, pick the client (Casey) in the role switcher and open `/agents`. Save a PayPal once (the saved-PayPal card; in simulated mode the approval is one click). Then create a mandate: the actions the agent may take (for example read, fund, approve, hold), an approval cap, fund caps (per milestone and in total) and an expiry; tick auto-fund to have the next milestone funded after each release. Copy the `msa_...` token; it is shown once. (`pnpm db:seed -- --reset --showcase` also creates one for Casey and prints its token.)
2. Connect an MCP client with that token, as described in [docs/mcp.md](docs/mcp.md). For Claude Desktop, add `scripts/milestone-mcp.mjs` as a stdio server with `MILESTONE_URL` and `MILESTONE_AGENT_TOKEN`; for Cursor, point it at `http://localhost:3000/api/mcp` with an `Authorization: Bearer msa_...` header.
3. Or use the built-in console at `/agents/console` (needs `ANTHROPIC_API_KEY`): pick the mandate, paste its token, and talk to your agent. It uses the same MCP server, plus PayPal's MCP server read-only.

An agent funds only the next draft milestone of an approved contract, for exactly its amount and currency, within the mandate's fund caps, from a saved PayPal that belongs to its user; the funding guarantee is in [docs/mcp.md](docs/mcp.md). An agent's approve is accepted only when the policy already decided release for the latest delivery, every required criterion passed and the amount is within the mandate's cap. No agent tool pays out or refunds. Every call, accepted or refused, is in the audit log as `agent:<name> for <user>`, and `/agents` shows it. Revoking the mandate stops the agent on its next call.

## Tools used

- **Claude** (`claude-sonnet-5-5` by default) through the Anthropic SDK, optional (`ANTHROPIC_API_KEY`): judges the judgment criteria of a delivery and must cite evidence, compiles a scope into a contract, phrases advance offers, drafts dispute responses, and drives the agent console. It never decides payment; the pure `decide()` policy does.
- **Model Context Protocol:** Milestone's own MCP server (`/api/mcp`) lets AI agents (Claude Desktop, Cursor, the built-in console) act under a capped mandate; **PayPal's MCP server** (`@paypal/mcp`) is used read-only for reconciliation, disputes and the console.
- **PayPal developer platform** (the hosted demo runs on the real sandbox; a built-in simulator of the same calls covers keyless local runs): Orders v2 and JS SDK v6 checkout to fund a milestone, Payment Method Tokens v3 to save a client's PayPal once so an agent can fund the next milestone, Payouts v1 to release (one batch, a lending partner repaid first), Refunds for the unpassed share of a partial release, Invoicing v2 receipts, Disputes, and signature-verified webhooks; a milestone is Released only when the payout webhook confirms it. Every POST carries `PayPal-Request-Id` from a stored operation, so a retry never pays twice.
- **PayPal Acceptable Use Policy check:** before a contract can be signed or funded, a keyword pass and Claude screen it against PayPal's Acceptable Use Policy (each flag must quote the contract); a pure rule blocks signing and funding until an operator clears a flag on `/ops`.
- **AG Grid Community:** four grids. The contract ledger (double-entry legs with a pinned totals row that shows the books balance, quick filter and money filters that work in dollars over cents), the lending partner's book (pinned book total, exposure and repayment cells), the audit log and the receipt's evidence (expandable full-width detail rows). One Theming API theme follows the app's light and dark mode.
- **Render:** `render.yaml` is a one-click Blueprint: one web service running Next.js and the job worker, Postgres, and a disk; the start script refuses to boot on the sandbox without its keys.
- **Postman:** `fixtures/postman/milestone.postman_collection.json` covers every API route.
- **APIMatic:** a TypeScript SDK generated from the OpenAPI spec, in `sdks/typescript/`.
- **Claude Code** was the coding assistant; **Kokoro TTS** was used only to preview the demo video's narration timing.

## Documentation

- [docs/architecture.md](docs/architecture.md): components, state machine, money route, jobs, the agent layer, data model.
- [docs/mcp.md](docs/mcp.md): the Milestone MCP server, mandates and the agent guarantee.
- [docs/eval.md](docs/eval.md): the model eval set and runs.
- [fixtures/real-repos/README.md](fixtures/real-repos/README.md): 29 deliveries against real repositories, including red-team attacks.
- [docs/openapi.yaml](docs/openapi.yaml) and [docs/apimatic.md](docs/apimatic.md): the OpenAPI spec, and the TypeScript SDK APIMatic generated from it (`sdks/typescript/`, with a working example).
- [fixtures/postman/milestone.postman_collection.json](fixtures/postman/milestone.postman_collection.json): Postman collection.
- [docs/deploy.md](docs/deploy.md): deploying the hosted demo to Render.
- [docs/runbook.md](docs/runbook.md): operator runbook.
- [CLAUDE.md](CLAUDE.md): the non-negotiable rules and layout for contributors.

## Structure

`apps/web` (UI, API routes, webhooks, the MCP server at `/api/mcp`, `/agents`), `apps/worker` (verify, release, settle, advance, dispute and reconcile jobs), `packages/core` (schemas, ledger, state machine, mandates), `packages/money` (PayPal client, PayPal MCP client and policy), `packages/verify` (compiler, deterministic stage, judgment). Only `packages/money/src/policy/execute.ts` moves money, enforced by `pnpm check:boundaries` in CI. `render.yaml` is the Render blueprint for the hosted demo (one service running web and worker, plus Postgres and a disk, on the real PayPal sandbox).

Known limitation: delivered code runs on the worker host with network access; a real deployment needs a container or microVM per verification.

## Screenshots

![A delivery being verified: the client's suite runs against the delivered commit and the checks fill in live](docs/images/03-verifying.png)

Verifying live (simulated PayPal): the client's own tests grade the delivered commit, and each check fills in as the log streams.

![An opened receipt: every criterion with its confidence and cited evidence ids, and the policy's release stamp](docs/images/04-receipt.png)

The receipt (simulated PayPal): each verdict cites its evidence, and the release stamp names the policy rule (P6) that decided it, not the model.

![A released milestone: the payout repays the partner's advance first and pays the freelancer the rest](docs/images/05-release.png)

The release split (simulated PayPal): one payout repays Parker's $50 advance plus fee and pays Frankie the rest, marked final once PayPal confirms.

![The agents page: Casey's mandate and the audit of what the agent did, including a refused approval](docs/images/06-agents.png)

Agents under a mandate: reads, a refused approve outside the policy's decision, and an accepted early approval, all in the audit.

The other four (home, the milestone rail, the criteria editor and the lender's book) are in [docs/images](docs/images).

## Licence

Open source under the MIT License, see [LICENSE](LICENSE).
