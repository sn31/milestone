# Milestone

Payment on verified delivery for freelance work. The client funds a milestone through PayPal. When the freelancer delivers, an agent checks the work against the agreed acceptance criteria, a deterministic policy decides, and PayPal pays out. If one criterion fails, the verified share is paid and the rest is refunded.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) on the PayPal sandbox. Claude (Anthropic SDK) compiles contracts, judges the criteria a program cannot check, and explains decisions; it never moves money. Advances ("Get paid now") are paid from a separate capital-partner account, a sandbox account or the built-in simulator. Deliveries can be a merged pull request, a commit submitted by hand, or uploaded files.

## Quick start

Needs Node 24+, pnpm, and Docker (or any Postgres).

```bash
git clone <this repository> milestone && cd milestone
pnpm install
cp .env.example .env          # set PAYPAL_MODE=simulated (once) and ANTHROPIC_API_KEY
docker compose up -d          # Postgres on :5432 (user, password, db: milestone)
pnpm db:migrate
pnpm db:seed
pnpm dev                      # web on http://localhost:3000, worker in the same terminal
```

Notes:
- `PAYPAL_MODE=simulated` is the default no-credentials path: a local simulator stands in for PayPal, shares its state between web and worker in `var/simulated-paypal.json` (delete it to reset) and posts its own webhooks. `.env.example` lists `PAYPAL_MODE` twice; keep one line. For the real sandbox set `PAYPAL_MODE=sandbox` with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and the partner app's credentials; see `docs/runbook.md`.
- `ANTHROPIC_API_KEY` is needed for judgment criteria to be judged, for compiling a scope into a contract and for model-phrased advance explanations. Without it the contract form builds a fixed three-milestone demo contract, and a delivery that passes every checkable criterion goes to "needs client" instead of the review window, because the judgment criteria stay unclear.
- Set `PAYPAL_FREELANCER_EMAIL` and `PAYPAL_PARTNER_EMAIL` before `pnpm db:seed`; advances need both receivers.
- Build the demo repository with `scripts/make-demo-repo.sh <dir>`. Its branches are `m1-pass` (all tests pass), `m2-partial` (the annual-discount test fails and an existing test file was edited, so the milestone is held) and `m2-injection` (same code, commit message tries to instruct the reviewer; flagged). Deliver a branch from the milestone's Deliver form (repository path and branch) or by merging a pull request with the GitHub webhook set up.
- Check everything with `pnpm typecheck`, `pnpm test` and `pnpm check:boundaries`. Postgres-backed end-to-end suites are opt-in with `MILESTONE_E2E=1 pnpm test`.

## Demo roles

The role switcher in the header sets a cookie. There is no sign-in; this is a demo stand-in.

- client (Casey): approves contracts, funds milestones, approves, vetoes or confirms partial releases.
- freelancer (Frankie): approves contracts, delivers (merged pull request, a commit, or uploaded files) and takes advances.
- partner (Parker): the capital partner and operator; sees the lender's book at `/lender` and resolves cases at `/ops`.

Seed data: two active contracts. "Signup flow for a SaaS landing page" (`ctr_demo`) has three milestones of $100 that match the demo repo branches. "Brand refresh for a bakery" (`ctr_brand`) has two milestones whose criteria are uploaded files (logo, PDF style guide, website copy).

## Documentation

- [docs/submission.md](docs/submission.md): the Devpost text.
- [docs/architecture.md](docs/architecture.md): components, state machine, money route, jobs, data model.
- [docs/video-script.md](docs/video-script.md): the demo video script.
- [docs/openapi.yaml](docs/openapi.yaml) and [docs/apimatic.md](docs/apimatic.md): API spec and SDK generation.
- [fixtures/postman/milestone.postman_collection.json](fixtures/postman/milestone.postman_collection.json): Postman collection.
- [docs/runbook.md](docs/runbook.md): operator runbook.
- [CLAUDE.md](CLAUDE.md): the non-negotiable rules and layout for contributors.

## Structure

`apps/web` (UI, API routes, webhooks), `apps/worker` (verify, release, settle, advance jobs), `packages/core` (schemas, ledger, state machine), `packages/money` (PayPal client and policy), `packages/verify` (compiler, deterministic stage, judgment). Only `packages/money/src/policy/execute.ts` moves money, enforced by `pnpm check:boundaries` in CI. Render deployment is planned; `render.yaml` is an undeployed draft. Also planned: the KERNEL visual stage, a Bryntum timeline, a disputes copilot and negotiation.

Known limitation: delivered code runs on the worker host with network access; a real deployment needs a container or microVM per verification.

## Licence

MIT, see [LICENSE](LICENSE).
