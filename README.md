# Milestone

Payment on verified delivery for freelance work. The client funds a milestone through PayPal. When the freelancer delivers, an agent checks the work against the agreed acceptance criteria, a deterministic policy decides, and PayPal pays out. If one criterion fails, the verified share is paid and the rest is refunded.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) on the PayPal sandbox. Claude (Anthropic SDK) compiles contracts, judges the criteria a program cannot check, and explains decisions; it never moves money. Advances are simulated with a sandbox capital-partner account and are not built yet.

## Quick start

Needs Node 24+, pnpm, and Docker (or any Postgres).

```bash
git clone <this repository> milestone && cd milestone
pnpm install
cp .env.example .env          # add PayPal sandbox credentials and ANTHROPIC_API_KEY
docker compose up -d          # Postgres on :5432 (user, password, db: milestone)
pnpm db:migrate
pnpm db:seed
pnpm dev                      # web on http://localhost:3000, worker in the same terminal
```

Notes:
- Without `ANTHROPIC_API_KEY` the contract form builds a fixed three-milestone demo contract and verification runs deterministic checks only.
- Funding needs PayPal sandbox credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`). `PAYPAL_MODE=simulated`, a no-credentials run, is planned and not implemented yet; see `docs/runbook.md`.
- Build the demo repository with `scripts/make-demo-repo.sh <dir>`. Its branches are `m1-pass` (all tests pass), `m2-partial` (one test fails) and `m2-injection` (same code, commit message tries to instruct the reviewer).
- Check everything with `pnpm typecheck`, `pnpm test` and `pnpm check:boundaries`. Postgres-backed tests are opt-in with `MILESTONE_E2E=1`.

## Demo roles

The role switcher in the header sets a cookie. There is no sign-in; this is a demo stand-in.

- client (Casey): approves contracts, funds milestones, approves, vetoes or confirms partial releases.
- freelancer (Frankie): approves contracts and delivers by merging pull requests.
- partner (Parker): the capital partner and operator; resolves cases at `/ops`.

Seed data: one active contract, "Signup flow for a SaaS landing page", with three milestones of $100.

## Documentation

- [docs/submission.md](docs/submission.md): the Devpost text.
- [docs/architecture.md](docs/architecture.md): components, state machine, money route, jobs, data model.
- [docs/video-script.md](docs/video-script.md): the demo video script.
- [docs/openapi.yaml](docs/openapi.yaml) and [docs/apimatic.md](docs/apimatic.md): API spec and SDK generation.
- [fixtures/postman/milestone.postman_collection.json](fixtures/postman/milestone.postman_collection.json): Postman collection.
- [docs/runbook.md](docs/runbook.md): operator runbook.
- [CLAUDE.md](CLAUDE.md): the non-negotiable rules and layout for contributors.

## Structure

`apps/web` (UI, API routes, webhooks), `apps/worker` (verify, release, settle, advance jobs), `packages/core` (schemas, ledger, state machine), `packages/money` (PayPal client and policy), `packages/verify` (compiler, deterministic stage, judgment). Only `packages/money/src/policy/execute.ts` moves money, enforced by `pnpm check:boundaries` in CI. Deployment to Render is described in `render.yaml`.

Known limitation: delivered code runs on the worker host with network access; a real deployment needs a container or microVM per verification.

## Licence

MIT, see [LICENSE](LICENSE).
