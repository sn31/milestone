# Deploying the hosted demo on Render

The repository holds a Render Blueprint (`render.yaml`). It describes one web service that runs the Next.js app and the job worker side by side, a Postgres database, and a 1 GB disk for the files both processes share. Deploying it takes a Render account and about ten minutes, most of it the first build.

`node scripts/check-render.mjs` (run in CI) checks the Blueprint against Render's spec and checks that every environment variable the code reads is either set there or listed under "Optional environment variables" below.

## What the hosted demo is

- **Demo mode** (`DEMO_MODE=1`). Every page shows a thin band: "Demo: PayPal sandbox or simulated, test identities; reset any time". The band also says which judgment is live: "Judgment by Claude" when `ANTHROPIC_API_KEY` is set, "Judgment goes to the client: no model on this host" otherwise. The band's **Reset demo** button posts to `/api/demo/reset`, which puts the showcase back (the seed with `--reset --showcase`, then the PayPal simulator's state in `SIMULATED_PAYPAL_STATE_FILE` is emptied and every uploaded file in `UPLOAD_DIR` is deleted; Casey's seeded saved PayPal is a database row the simulator adopts again on first use). The seed also queues the release job for the showcase milestone in review, so when its window closes the worker releases it as it would any other. A reset runs at most once every 30 seconds, and the route answers 404 when `DEMO_MODE` is not `1`.
- **PayPal simulated by default** (`PAYPAL_MODE=simulated`). A built-in simulator answers the same REST calls as the PayPal sandbox and posts its own signed webhooks to the service, so the demo needs no PayPal account. You can switch to the real sandbox (see below).
- **Identities** come from a role switcher (client, freelancer, partner), not a sign-in.
- **Code deliveries come from the demo repository only.** Delivered code is not sandboxed (it runs on the host under the service's user), so with `DEMO_MODE=1` the deliver route, the MCP `deliver_milestone` tool and the GitHub webhook accept a repository delivery only when its URL names `DEMO_REPO_URL` (compared after normalising: https only, host lowercased, `.git` and a trailing slash dropped, owner and name case-insensitive on github.com; credentials, ports, query strings, fragments, percent-encoding and `..` segments are refused). Anything else gets a 403 with the reason and a `delivery.refused` audit row, before `git ls-remote`, the delivery row or the verify job. The worker checks again before it clones: a queued delivery from another repository is never cloned, and its criteria are recorded `unclear` with the reason, so it goes to the client. With `DEMO_MODE=1` and `DEMO_REPO_URL` unset, every code delivery is refused (fail closed). File uploads are not code and stay open.
- **No local repositories.** The web app refuses local paths and `file://` URLs in production and whenever `DEMO_MODE=1` (`MILESTONE_ALLOW_LOCAL_REPOS` is unset). The start script also gives both processes a `git` restricted to https, so no other route can make the worker fetch a `file://`, local-path, ssh or `git://` repository.

## Owner's steps

1. **Create a Render account** at https://dashboard.render.com/register. Sign up with GitHub, or connect GitHub afterwards under Account Settings, then Git Providers, so Render can read the repository.
2. **Click New, then Blueprint**, and pick this repository and the `main` branch. Render reads `render.yaml` and lists what it will create: the web service `milestone`, the database `milestone-db` and the disk `milestone-var`.
3. **Fill in the optional secrets.** Render asks once for each `sync: false` variable. For the simulated demo, all of them can stay empty.
   - `ANTHROPIC_API_KEY`: set it to have Claude judge the judgment criteria. Leave it empty and those criteria go to the client, which the banner says.
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID`: only for the real sandbox (see below).
   - `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN`: only to deliver through merged pull requests, and to record the default branch as the tamper-check baseline when a milestone is funded.
   - `DEMO_REPO_URL`: **required for code deliveries.** The https URL of the public demo repository you pushed in [The GitHub demo repository](#the-github-demo-repository) (for example `https://github.com/<you>/landing`). It is the only repository the hosted demo accepts code from; left empty, every code delivery is refused and only file uploads work. Push the repository first, so the first deploy's seed names it on the demo contract.
4. **Click Apply.** Render creates the database, builds, runs the pre-deploy command, then starts the service. The service URL appears at the top of the service page (for example `https://milestone-xxxx.onrender.com`).
5. **Open the URL.** You land on the contract ledger, with the demo band at the top.

Costs: the web service is on the `1c-2g` plan and the database on `0.1c-256mb`, plus the 1 GB disk. The free plan cannot attach a disk or run a pre-deploy command, so the Blueprint does not use it. `0.5c-512mb` is enough to browse, but it can run out of memory while the worker runs a delivered repository's `npm install` and test suite.

## What a deploy does

Build (`buildCommand`): `corepack enable` provides the pnpm version pinned in `package.json`. Then `pnpm install --frozen-lockfile` runs with dev dependencies, because `tsx` (which runs the worker and the seed) and `drizzle-kit` (migrations) are needed at run time, and `pnpm --filter @milestone/web build` builds the app.

Pre-deploy (`preDeployCommand`, `node scripts/start-render.mjs predeploy`), on every deploy:

1. `drizzle-kit migrate` applies any new migrations.
2. `seed --showcase --if-empty` seeds the demo only when the `users` table is empty. On the **first deploy** the table is empty, so the database gets the full showcase: three contracts, and milestones in every state (funded, in review with the window open, released, waiting on the client after a partial verdict, held after a failed payout for the operator queue, and a second client's funded milestone with an open advance), plus five past releases for the freelancer's history. Later deploys find the users and leave the data alone. Use Reset demo to start over.

Start (`startCommand`, `node scripts/start-render.mjs`): sets `APP_URL` from `RENDER_EXTERNAL_URL` when it is not set, puts the https-only `git` first on `PATH`, then starts `next start` on Render's `PORT` and the worker. If either process exits, the script stops the other and exits, and Render restarts the service.

The disk is mounted at `/var/data`. It holds the simulator's state (`SIMULATED_PAYPAL_STATE_FILE`), uploaded deliveries (`UPLOAD_DIR`) and npm's cache for verification runs (`MILESTONE_NPM_CACHE`), so a restart keeps them. A service with a disk cannot scale beyond one instance. The demo needs only one.

The health check is `GET /api/dev/paypal/mode`. It answers with the PayPal mode and does not touch the database.

## The GitHub demo repository

The hosted worker clones over https and needs no credentials, so the repository it verifies must be **public**. The demo repository lives in `fixtures/demo-repo`. To publish it:

1. On GitHub, create a new **public**, **empty** repository (no README, licence or .gitignore), for example `landing`.
2. From a checkout of this repository, run:

   ```bash
   scripts/render-push-demo-repo.sh https://github.com/<you>/landing.git
   ```

   The script builds the repository with `scripts/make-demo-repo.sh` and pushes `main` and three delivery branches: `m1-pass` (passes), `m2-partial` (the client's discount test fails) and `m2-injection` (a commit message that tries to instruct the verifier). It never force-pushes. It then checks that an anonymous clone works, as it will on Render.
3. On the Render service's Environment page, set `DEMO_REPO_URL` to `https://github.com/<you>/landing` and save (this redeploys). The hosted demo accepts code deliveries from this repository only; see [What the hosted demo is](#what-the-hosted-demo-is).
4. In the demo, switch to Freelancer, open the signup-flow contract, and deliver a funded milestone. The deliver form suggests `DEMO_REPO_URL`; set the branch to one of the three above.

The seed names the demo contract's repository after `DEMO_REPO_URL` when it is a github.com URL, and falls back to `milestone-demo/landing` otherwise. A database seeded before you set it keeps the old name until you click **Reset demo**; the deliver form suggests `DEMO_REPO_URL` either way, and only that repository is accepted.

## Switching to the PayPal sandbox

1. In the PayPal Developer Dashboard, under Apps & Credentials with Sandbox selected, create (or open) the platform app. Under Features, enable **Payouts**. Make sure the platform's sandbox business account has a balance.
2. In the app, add a webhook with the URL **`<render url>/api/webhooks/paypal`** (for example `https://milestone-xxxx.onrender.com/api/webhooks/paypal`). Subscribe to these events:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.PAYOUTSBATCH.DENIED`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.FAILED`, `.BLOCKED`, `.DENIED`, `.CANCELED`, `.UNCLAIMED`, `.HELD`, `.RETURNED`, `.REVERSED`, `.REFUNDED`
   - `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`
   - `INVOICING.INVOICE.PAID` (stored in the audit log only)
   - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED` (recorded; saving a PayPal does not depend on them)

   Copy the webhook's id.
3. On the Render service's Environment page, set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID`, and change `PAYPAL_MODE` to `sandbox`. For advances, also set `PAYPAL_PARTNER_CLIENT_ID` and `PAYPAL_PARTNER_CLIENT_SECRET`, the credentials of a second sandbox business account's app. Without them, the advance job refuses rather than paying from the platform account. Set `PAYPAL_FREELANCER_EMAIL` and `PAYPAL_PARTNER_EMAIL` to sandbox personal and business accounts, so payouts have real receivers.
4. To let clients save a PayPal and agents fund from it, open the app in the Developer Dashboard, go to Features, and under Accept payments open Advanced options and tick **Vault**. Without it `POST /v3/vault/setup-tokens` is refused. In the sandbox that is all; in production, charging a saved PayPal without the buyer present also needs PayPal's approval for reference transactions. 
5. Save, which redeploys. To apply the receivers to the seeded users, click Reset demo once after the deploy.

In simulated mode (the default on Render) the vault is the simulator, needs no setting, and the showcase seed carries a saved PayPal for Casey. To switch back, set `PAYPAL_MODE` to `simulated` and save. Never set `PAYPAL_ENV=live` for the demo.

## Optional environment variables

Every variable the code reads is either set in `render.yaml` or listed here. `scripts/check-render.mjs` fails CI when one is missing from both.

| Variable | On Render | What it does |
|---|---|---|
| `APP_URL` | Set automatically | The public base URL, used for PayPal return links, the simulator's webhooks and agent links. The start script sets it from `RENDER_EXTERNAL_URL`; set it yourself only for a custom domain. |
| `MILESTONE_MODEL` | Optional | The Claude model id (default `claude-sonnet-5-5`). The seed also writes it on showcase verdicts. |
| `ANTHROPIC_BASE_URL` | Leave unset | Overrides the Anthropic API URL (a proxy). |
| `MILESTONE_ALLOW_LOCAL_REPOS` | Leave unset | `1` lets deliveries name local paths and `file://` URLs, and lifts the https-only `git`. Never on a public host. |
| `MILESTONE_MCP_URL` | Optional | Where the agent console finds the MCP server. Defaults to `APP_URL`. |
| `MILESTONE_PARTNER_ID` | Optional | The partner user new advances are booked to. Defaults to the first partner user. |
| `MILESTONE_UPLOAD_BUDGET_BYTES` | Optional | Total size `UPLOAD_DIR` may reach before file deliveries are refused with 413 (default 524288000, 500 MB; measured at most every 30 s). Keeps visitors' uploads from filling the disk. |
| `PAYPAL_PARTNER_CLIENT_ID` | Sandbox only | The capital partner's sandbox app, which pays advances. |
| `PAYPAL_PARTNER_CLIENT_SECRET` | Sandbox only | Secret for the partner's sandbox app. |
| `PAYPAL_FREELANCER_EMAIL` | Sandbox only | The seeded freelancer's payout receiver (a sandbox personal account). |
| `PAYPAL_PARTNER_EMAIL` | Sandbox only | The seeded partner's payout receiver. |
| `SPIKE_FREELANCER_EMAIL` | Leave unset | Fallback for `PAYPAL_FREELANCER_EMAIL`, used by the local money spike. |
| `PAYPAL_PLATFORM_EMAIL` | Optional | The platform's email, printed on receipts. |
| `PAYPAL_MCP_RESOLVE_FROM` | Leave unset | Where the PayPal MCP server is resolved from. Found automatically. |
| `REVIEW_WINDOW_SECONDS` | Optional | Overrides every contract's client review window (minimum 30 s). Useful for a fast live demo. |
| `RECONCILE_WINDOW_HOURS` | Optional | The reconciliation job's look-back window. |
| `RECONCILE_LAG_HOURS` | Optional | How far behind the present reconciliation stops, so PayPal's reporting can catch up. |

Platform variables that Render provides and the code reads: `PORT`, `RENDER_EXTERNAL_URL`, `NODE_ENV` (set to `production` in the Blueprint), `PATH` and `HOME`.

## Known limits of the hosted demo

- Delivered code runs on the service's host under the service's user, with network access. Only the child environment is cleaned (see CLAUDE.md, "Known limitation"). That is why hosted deliveries are limited to public https repositories, but it is still not a sandbox. A real deployment needs a container or microVM per verification.
- Anyone with the URL can switch roles, act on milestones and reset the demo. That is intended for judging.
- Reset demo truncates every table. Contracts that visitors created are lost, and the showcase is rebuilt.
