# Operator runbook

## What needs_operator means

The release job makes one payout attempt per milestone. If any item of that attempt fails, is blocked, returned, reversed or refunded, or PayPal rejects the payout or refund outright (or it still fails on the job's last retry), the milestone moves to `held` and an audit entry `milestone.needs_operator` is written. From then on the release job refuses to run for that milestone (`release.refused_needs_operator`) and a new delivery will not move it out of `held` (`verify.refused_needs_operator`). Nothing is retried automatically, so nothing can be paid twice. A person resolves it by hand.

## The operator queue

Open `/ops` as the partner role (the role switcher in the header). It lists every milestone whose latest operator event is `milestone.needs_operator`, with amount, status and flag time. For each one:

- Reason: why it was flagged.
- Paid: items PayPal confirmed as paid.
- Failed: items that failed or were blocked, with PayPal's reason.
- Reversed: items paid and then reversed, with amounts.
- Pending: items still awaiting a PayPal answer.
- Refunded: refund amounts already settled.
- PayPal ops: the `paypal_ops` rows (payout, refund) with status, PayPal id and request id.

The same data is in `audit_log.detail` of the `milestone.needs_operator` row.

## Resolving each case

Always start in the PayPal sandbox dashboard (Transactions) using the PayPal id from the ops row, and confirm what actually happened before doing anything.

Failed or blocked item. The freelancer was not paid. The funds are still in the platform account. Fix the cause (usually the receiver's email is wrong or the account cannot receive), pay the freelancer by hand from the dashboard, then record it.

Reversal or return. A paid item came back (`paypal.payout_reversed`, `milestone.reversed`). Decide with both parties whether to pay again by hand or refund the client from the capture, then record it.

Failed refund. A partial release paid out but the refund of the unverified share failed (`paypal.refund_failed`). Refund the client by hand against the capture id shown in the audit detail (`POST /v2/payments/captures/{id}/refund` or the dashboard), then record it.

Recording the resolution: submit the note on the `/ops` card, or `POST /api/ops/{milestoneId}/resolve` with `{"note": "..."}` as the partner. This writes `ops.resolved` and removes the card from the queue. It does not move money and does not change the milestone status; the manual PayPal action does that.

## Audit events to search

`audit_log.event`: `milestone.needs_operator`, `ops.resolved`, `release.refused_needs_operator`, `verify.refused_needs_operator`, `release.claimed`, `release.waiting`, `release.skipped_in_flight`, `paypal.payout`, `paypal.refund`, `paypal.payout_error`, `paypal.refund_error`, `paypal.payout_failed`, `paypal.payout_reversed`, `paypal.payout_batch_denied`, `paypal.payout_unmatched`, `paypal.unmatched_batch`, `paypal.refund_failed`, `paypal.refund_unmatched`, `paypal.capture_unmatched`, `milestone.capture_mismatch`, `milestone.settle_conflict`, `milestone.reversed`, `advance.repayment_failed`, `ledger.skipped`, `paypal.receipt_failed`, `delivery.manual`, `delivery.upload`, `advance.accepted`, `advance.funded`, `advance.needs_operator`, `advance.withdrawn`, `advance.refused`, `advance.skipped`, `advance.config_error`, `paypal.advance_payout_error`. Example:

```sql
select created_at, actor, event, detail from audit_log where milestone_id = 'mst_1' order by created_at;
```

## Enable Payouts on the sandbox app

In the PayPal Developer Dashboard, open Apps & Credentials, switch to Sandbox, open the app whose credentials are in `.env`, and under Features tick Payouts (and save). The platform business account must hold a sandbox balance; top it up from the sandbox account page if payouts fail for lack of funds. Advances need a second sandbox business account with its own app, whose credentials go in `PAYPAL_PARTNER_CLIENT_ID` and `PAYPAL_PARTNER_CLIENT_SECRET`. Create the webhook for the app, point it at `{APP_URL}/api/webhooks/paypal` with the events handled by the route, and put its id in `PAYPAL_WEBHOOK_ID`.

## Run the money spike

Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `SPIKE_FREELANCER_EMAIL` (a sandbox account) in `.env`, then:

```bash
pnpm paypal:spike
```

It creates an order, asks you to approve it in the browser as the sandbox client account, captures it, pays a full release, then does a second order with a partial release (payout plus refund). Responses are written to `fixtures/paypal-recordings/spike.local.json`.

## Switching PAYPAL_MODE

`PAYPAL_MODE` is read by the web app and the worker. Both must agree, so set it in `.env` and restart `pnpm dev`.

- `PAYPAL_MODE=simulated`: no PayPal account needed. A local simulator answers the REST calls, and posts its own webhooks to `APP_URL/api/webhooks/paypal` about 1.5 seconds after a capture, payout or refund, authenticated by the `X-Milestone-Simulated` header (`SIMULATED_WEBHOOK_SECRET`, default `dev` outside production, required in production). The fund button becomes a dashed amber "simulated" button; the approve step is instant.
- `PAYPAL_MODE=sandbox`: the real sandbox. Needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and, for advances, `PAYPAL_PARTNER_CLIENT_ID` and `PAYPAL_PARTNER_CLIENT_SECRET`. Without partner credentials the advance job throws rather than pay from the platform account.
- Unset: simulated when `PAYPAL_CLIENT_ID` is empty and `NODE_ENV` is not `production`, sandbox otherwise.

`PAYPAL_ENV` (`sandbox`, the default, or `live`) is separate. Do not set `live` for the hackathon. `GET /api/dev/paypal/mode` says which mode the server is in.

Note that `.env.example` lists `PAYPAL_MODE` twice (once as `simulated`, once empty). Keep only one line so the mode is what you intend.

## Resetting the simulator

The simulator keeps its orders, captures, payouts, refunds, idempotency records and armed failures in `var/simulated-paypal.json` (or the path in `SIMULATED_PAYPAL_STATE_FILE`; the value `memory` keeps state in the process only). Stop `pnpm dev`, delete the file, and start again:

```bash
rm var/simulated-paypal.json
```

Reset the database too (`pnpm db:migrate` on a fresh volume, then `pnpm db:seed`) if the simulator state and the milestones no longer match; an order id in the database that the simulator no longer knows will fail to capture.

## Arming a payout failure

Only in simulated mode (the route answers 404 otherwise). To make the next payout item for a milestone fail once:

```bash
curl -X POST localhost:3000/api/dev/paypal/fail \
  -H 'content-type: application/json' \
  -d '{"sender_item_id":"mst_1:freelancer","reason":"RECEIVER_UNREGISTERED"}'
```

`sender_item_id` is `<milestoneId>:freelancer` or `<milestoneId>:partner`; `{"milestoneId":"mst_1","party":"freelancer"}` works too. `reason` is optional (default `RECEIVER_ACCOUNT_LOCKED`). The next release for that milestone then sees a FAILED item, the milestone goes to `held` and `milestone.needs_operator` appears on `/ops`. `GET /api/dev/paypal/fail` lists what is armed. The "Simulate payout failure" button on an `/ops` card arms it for that milestone's freelancer item. Arm it before the release job runs; each arming fires once.

## Seed environment variables

`pnpm db:seed` reads these from `.env`:

- `PAYPAL_FREELANCER_EMAIL`: the freelancer's PayPal receiver (falls back to `SPIKE_FREELANCER_EMAIL`). Without it, accepting an advance is refused with "add a PayPal email" in every mode, and a sandbox payout has no receiver.
- `PAYPAL_PARTNER_EMAIL`: the capital partner's PayPal account, which receives repayments. Without it, accepting an advance is refused (`no_partner_paypal_email`), except in simulated mode, where the partner's account email is used.

Reseeding is idempotent, but the seed's user upsert does not update `paypal_email` on an existing user. Set both variables before the first `pnpm db:seed`; to change them later, update `users.paypal_email` directly or reseed a fresh database.

## The model key

`ANTHROPIC_API_KEY` is required for judgment criteria to be judged (and for the contract compiler and model-phrased advance explanations). Without it the contract form builds a fixed three-milestone demo contract, and verification runs the deterministic or upload checks only: every judgment criterion is unclear, the model is recorded as `deterministic-only`, and a delivery that passes everything else goes to "needs client" under rule P3 instead of review. Set the key for the recording; `MILESTONE_MODEL` picks the model.

## Local models with Ollama

Ollama is the default model backend; no Anthropic key is needed. `packages/verify/src/llm.ts` uses it whenever `MODEL_PROVIDER=ollama`, or when `MODEL_PROVIDER` is unset and `ANTHROPIC_API_KEY` is empty. Claude stays available with `MODEL_PROVIDER=anthropic` (or just a key and no `MODEL_PROVIDER`).

Setup (M2 Max, 32 GB is comfortable; the two models take about 15 GB of disk):

```bash
ollama serve                 # http://localhost:11434; another host: OLLAMA_HOST=host:port
ollama pull qwen3:14b        # text: contract compiler, verifier judgment, explanations
ollama pull qwen2.5vl:7b     # vision: any request that carries an image (view_file on a PNG/JPG)
```

Variables: `MILESTONE_MODEL` (default `qwen3:14b`; a leftover `claude-*` value is ignored under Ollama), `MILESTONE_VISION_MODEL` (default `qwen2.5vl:7b`), `OLLAMA_HOST`, `MILESTONE_OLLAMA_TIMEOUT_MS` (per HTTP call, default 600000; the first call loads the model).

How it maps: read-only tools use Ollama tool calling; the final answer is one more `/api/chat` turn with `"format"` set to the answer's JSON schema, so the reply is grammar-constrained JSON that the zod schema then validates as before. Requests run with `temperature: 0`, `num_ctx: 32768`, `stream: false` and `think: false` (qwen3); any `<think>` text is stripped anyway. `isModelConfigured()` (exported from `llm.ts`) answers whether a model can be called: for Ollama, `GET /api/tags` answers within 1 s and lists `MILESTONE_MODEL` (cached 30 s).

Limits: Ollama vision models cannot read PDFs, so `view_file` on a PDF hands the model the text extracted from it with a note saying so; layout and pictures inside a PDF are not seen. qwen2.5vl has no tool calling, so once an image is in the conversation the vision model answers directly from what was gathered. The eval set is small; the regex injection pre-pass, the parser and the policy apply unchanged whichever model runs.

Check the local model against the eval set (opt-in, about 4 minutes):

```bash
MILESTONE_MODEL_EVAL=1 pnpm --filter @milestone/verify exec vitest run test/model-eval.test.ts --silent=false
```

It runs `judge()` on the 20 cases in `fixtures/eval/cases.json`, prints per-case results, agreement and the false-release count, and fails if any case releases money it should not or fewer than 80% of cases agree. On 2026-10-08 with `qwen3:14b` on an M2 Max: 20/20 cases agree (result, action and injection flag), 0 false releases, 11.7 s per case on average (19 s max). The contract compiler produced valid contracts for both seed scopes in about 20 s each.

## The end-to-end suites

Unit tests run with `pnpm test`. The suites that need Postgres are opt-in: start Postgres (`docker compose up -d`), run `pnpm db:migrate`, then

```bash
MILESTONE_E2E=1 pnpm test
```

They are `apps/worker/src/lib/verify.e2e.test.ts` (verify against a throwaway git repo, and upload deliveries), `apps/worker/test/money-path.e2e.test.ts` (review, release and settle with PayPal faked at the HTTP layer), `release-settle.e2e.test.ts` and `advance.e2e.test.ts`. They use `DATABASE_URL`, tag every row they create and remove it afterwards, and mock the job queue. Run them against a development database, not one you are about to demo from.
