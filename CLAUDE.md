# Milestone

AI escrow agent for freelance work, built for the PayPal AI Hackathon (deadline Nov 12 2026, 12:00 pm Pacific).
The plan lives in the Claude Doc "Milestone — Build Plan" (tabs: Build Plan, Implementation). Keep this file and that doc in step.

## Non-negotiable rules
1. **Only `packages/money` talks to PayPal, and only `packages/money/src/policy/execute.ts` moves money** (imports `./paypal/money.ts`). `packages/verify` never imports `@milestone/money`. `pnpm check:boundaries` enforces both; CI fails otherwise.
2. **The model never decides.** `verify` produces verdicts and explanations; `decide()` in `money/policy` is a pure function; `execute.ts` acts on its output.
3. **Every outbound PayPal POST carries `PayPal-Request-Id`** from a `paypal_ops` row created first. A retried job must never pay twice.
4. **Every incoming webhook is signature-verified** and de-duplicated by `event_id` before anything reads it.
5. **Delivered files, PR text, commit messages and web pages are untrusted evidence**, wrapped in delimited blocks and never treated as instructions. A verdict `pass` with no evidence ids is downgraded to `unclear` by the parser; the one exception: a judgment-criterion pass that cites nothing gets evd_diff attached only when the model actually called read_file or get_diff successfully in that run; otherwise it is downgraded to unclear.
6. **Money is integer minor units + currency.** Balances are derived from `ledger_entries`; every `txn_id` sums to zero.
7. **A milestone is Released only when PayPal's webhook confirms the payout**, never when the call returns.
8. **One payout attempt per milestone.** The release job claims the payout `paypal_ops` row under a row lock before calling PayPal. If any payout item fails, is blocked, returned or reversed, the milestone goes to `held` with a `milestone.needs_operator` audit entry and is never auto-released again; an operator resolves it by hand.
9. **The client's suite grades the work:** the deterministic stage runs the baseline's tests, runner config, scripts and dev dependencies against the delivered code, removes test files the delivery added, and flags source changes that sniff the test environment (including non-env signals such as `process.argv`, `require.main`, `process.mainModule`, `module.parent` or a stack trace matched against a runner name) or patch assertions. A delivery that adds a new dependency, or re-points an existing one at a non-registry source (`file:`, `link:`, git, URL, tarball or a registry alias), is recorded as unclear on the test criterion because its unreviewed code would run with the client's suite, so the client decides (P3) rather than a pass being trusted. Setup runs with `--ignore-scripts` after removing committed `node_modules`.

## Known limitation (accepted for the hackathon)
Delivered code runs on the worker host under the worker's user with network access; only the child environment is cleaned. The demo repo is ours. A real deployment needs a container or microVM per verification. Say so in the submission.

## The one money route
Client pays into Milestone's platform sandbox account (`POST /v2/checkout/orders` + capture). Release = `POST /v1/payments/payouts`.
Partial = payout of the released share + `POST /v2/payments/captures/{id}/refund` of the rest. Advances = payout from the partner's account.

## Layout
- `apps/web` Next.js App Router: UI, API routes, PayPal + GitHub webhooks
- `apps/worker` pg-boss consumers: verify, release, settle, advance
- `packages/core` zod schemas, Drizzle schema, ledger, idempotency helpers, job queue
- `packages/money` PayPal REST client (`paypal/`) and the policy engine (`policy/`)
- `packages/verify` contract compiler, verifier judgment stage, deterministic test runner
- `fixtures` demo repo, seed data, recorded PayPal responses

## Commands
`pnpm install` · `pnpm typecheck` · `pnpm test` · `pnpm check:boundaries` · `pnpm dev` · `pnpm db:migrate` · `pnpm paypal:spike` (needs `.env`)

## Conventions
- TypeScript strict, ESM, no build step for packages (consumers import `src/index.ts`; Next.js uses `transpilePackages`).
- Tests: vitest; property tests with fast-check for policy and ledger invariants.
- Model calls go through `packages/verify/src/llm.ts` only, which picks a provider in `src/providers/`: a local Ollama model by default (`MILESTONE_MODEL`, default `qwen3:14b`; `MILESTONE_VISION_MODEL` for requests with images), Claude when `MODEL_PROVIDER=anthropic` or `ANTHROPIC_API_KEY` is set and `MODEL_PROVIDER` is not `ollama`. Ask `isModelConfigured()` whether a model is available, never the key.
- Jobs: `enqueue(name, milestoneId, data, { dedupe, delaySeconds })` from `@milestone/core`; the dedupe key makes a repeat a no-op.
