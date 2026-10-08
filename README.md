# Milestone

Payment on verified delivery for freelance work. The client funds a milestone through PayPal, an agent verifies the delivered work against agreed acceptance criteria, and a deterministic policy layer releases the money minutes after delivery.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) on the PayPal sandbox. Advances are simulated with a sandbox capital-partner account.

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in PayPal sandbox app credentials and ANTHROPIC_API_KEY
docker compose up -d        # Postgres (jobs live there too)
pnpm db:migrate
pnpm dev                    # web on :3000, worker in the same terminal
```

Verify the money plumbing before anything else:

```bash
pnpm paypal:spike           # create order -> approve in browser -> capture -> payout -> partial refund
```

## Structure

See `CLAUDE.md` for the layout, the money-boundary rules and the commands. The full plan is in the Claude Doc "Milestone — Build Plan".

## Licence

MIT, see `LICENSE`.
