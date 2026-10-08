# Seed data

`pnpm db:seed` loads a client, a freelancer with a verified history (so the advance offer is non-trivial), a capital partner
and the platform account, plus one approved contract with three milestones. Sandbox account emails come from `.env`.
Recorded PayPal responses for CI live in `fixtures/paypal-recordings/`.
