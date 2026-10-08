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

`audit_log.event`: `milestone.needs_operator`, `ops.resolved`, `release.refused_needs_operator`, `verify.refused_needs_operator`, `release.claimed`, `release.waiting`, `release.skipped_in_flight`, `paypal.payout`, `paypal.refund`, `paypal.payout_error`, `paypal.refund_error`, `paypal.payout_failed`, `paypal.payout_reversed`, `paypal.payout_batch_denied`, `paypal.payout_unmatched`, `paypal.unmatched_batch`, `paypal.refund_failed`, `paypal.refund_unmatched`, `paypal.capture_unmatched`, `milestone.capture_mismatch`, `milestone.settle_conflict`, `milestone.reversed`, `advance.repayment_failed`, `ledger.skipped`, `paypal.receipt_failed`. Example:

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

`PAYPAL_MODE` is planned and not read by any code yet. Today the only switch is `PAYPAL_ENV` (`sandbox`, the default, or `live`). Do not set `live` for the hackathon. Once the simulated mode is built, `PAYPAL_MODE=simulated` is meant to replace the PayPal client with a local stand-in so the demo runs without credentials, and removing the variable returns to the sandbox. Check the README before relying on it.
