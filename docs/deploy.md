# Deploying the hosted demo on Render

The repository holds a Render Blueprint (`render.yaml`). It describes one web service that runs the Next.js app and the job worker side by side, a Postgres database, and a 1 GB disk for the files both processes share. Deploying it takes a Render account, a PayPal Developer sandbox, and about twenty minutes, most of it the first build.

The hosted demo runs on the **real PayPal sandbox** (`PAYPAL_MODE=sandbox`): judges fund milestones through PayPal's own sandbox checkout, logging in with a sandbox buyer account, and payouts, refunds, advances and webhooks are PayPal's. The built-in simulator (`PAYPAL_MODE=simulated`) is the no-keys option for running the app locally from the README.

`node scripts/check-render.mjs` (run in CI) checks the Blueprint against Render's spec, checks that it declares every variable sandbox mode needs, and checks that every environment variable the code reads is either set there or listed under "Optional environment variables" below.

## What the hosted demo is

- **Demo mode** (`DEMO_MODE=1`). Every page shows a thin band: "Demo: real PayPal sandbox (test accounts, no real money), test identities; Reset demo resets this app's data, not PayPal's sandbox" (in simulated mode: "Demo: simulated PayPal (no real money), test identities; reset any time"). The band also says which judgment is live: "Judgment by Claude" when `ANTHROPIC_API_KEY` is set, "Judgment goes to the client: no model on this host" otherwise. The band's **Reset demo** button posts to `/api/demo/reset`, which puts the showcase back (the seed with `--reset --showcase`; every uploaded file in `UPLOAD_DIR` is deleted, and in simulated mode the simulator's state in `SIMULATED_PAYPAL_STATE_FILE` is emptied). On the real sandbox a reset only resets this app's database: PayPal's sandbox keeps its orders, payouts and refunds. A reset runs at most once every 30 seconds, and the route answers 404 when `DEMO_MODE` is not `1`.
- **PayPal: the real sandbox** (`PAYPAL_MODE=sandbox`). Checkout and capture, payouts, partial refunds, saved PayPal (vault) charges by agents, advances paid from the capital partner's own sandbox app, PayPal-signed webhooks verified against `PAYPAL_WEBHOOK_ID`, paid receipts (Invoicing) and reconciliation through PayPal's MCP server. A milestone is Released only when PayPal's payout webhook arrives.
- **The showcase on the real sandbox.** The signup-flow contract's three milestones start as drafts: that is the live path, funded for real through checkout. The other showcase states (the bakery's logo partial waiting on the client, its website copy held after a failed payout for the operator queue, a second client's funded milestone with an open advance, and the freelancer's five past releases) are recorded rows. Their PayPal ids are simulator ids that PayPal has never seen, so they are display only and marked **Recorded for the showcase**: the review, deliver, upload and advance routes refuse them (409 `recorded_for_showcase`), the release and advance jobs stop before PayPal is called (`release.refused_recorded`, `advance.withdrawn`), reconciliation leaves their ops out, and the PayPal client refuses to send any simulator id at all. Casey has no saved PayPal on the sandbox; she saves her own through PayPal's vault approval on `/agents`.
- **Identities** come from a role switcher (client, freelancer, partner), not a sign-in.
- **Code deliveries come from the demo repository only.** Delivered code is not sandboxed (it runs on the host under the service's user), so with `DEMO_MODE=1` the deliver route, the MCP `deliver_milestone` tool and the GitHub webhook accept a repository delivery only when its URL names `DEMO_REPO_URL` (compared after normalising: https only, host lowercased, `.git` and a trailing slash dropped, owner and name case-insensitive on github.com; credentials, ports, query strings, fragments, percent-encoding and `..` segments are refused). Anything else gets a 403 with the reason and a `delivery.refused` audit row, before `git ls-remote`, the delivery row or the verify job. The worker checks again before it clones: a queued delivery from another repository is never cloned, and its criteria are recorded `unclear` with the reason, so it goes to the client. The ref must also be a branch, a tag or `HEAD` of that repository, and a commit id is accepted only when it is the tip of one: anyone can open a pull request against a public repository, and GitHub then serves its head from that repository (`refs/pull/N/head`, and fork commits by id), so without this a stranger's code would pass the lock (422, nothing stored or queued). With `DEMO_MODE=1` and `DEMO_REPO_URL` unset, every code delivery is refused (fail closed). File uploads are not code and stay open.
- **No local repositories.** The web app refuses local paths and `file://` URLs in production and whenever `DEMO_MODE=1` (`MILESTONE_ALLOW_LOCAL_REPOS` is unset). The start script also gives both processes a `git` restricted to https, so no other route can make the worker fetch a `file://`, local-path, ssh or `git://` repository.

## Owner's steps

You need: a Render account, a GitHub account, and the PayPal Developer Dashboard (https://developer.paypal.com/dashboard/) with **Sandbox** selected. Keep every secret in the dashboards and on Render; never commit them.

### 1. PayPal sandbox accounts

Under **Testing Tools → Sandbox Accounts** you need four accounts (PayPal creates a default business and personal one; create the others with **Create account**):

| Account | Type | Used as |
|---|---|---|
| Platform | Business | Milestone's escrow account: the platform app below belongs to it. Checkout pays into it, payouts and refunds leave it. |
| Capital partner | Business | Pays advances from its own app. Its email is `PAYPAL_PARTNER_EMAIL` (where advance repayments go). |
| Freelancer | Personal | Receives payouts. Its email is `PAYPAL_FREELANCER_EMAIL`. |
| Buyer (judges) | Personal | Pays at checkout. Its email and password go in the Devpost testing instructions, nowhere else. |

Give the platform account a **balance** (open it, then edit the balance, for example USD 5,000): payouts are paid from the platform's PayPal balance, and a payout the balance cannot cover fails, which holds the milestone for the operator. Every released milestone draws it down, and a reset does not refill it, so check it before judging and top it up when it runs low. Give the buyer a balance too (or keep the sandbox card PayPal attached), so checkout always has a funding source.

### 2. The platform app

Under **Apps & Credentials** (Sandbox), create an app (Merchant) on the **platform** business account, or open the one you have. Copy its **Client ID** and **Secret** (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`). Under the app's **Features**:

- tick **Payouts** (without it `POST /v1/payments/payouts` is refused and every release is held for the operator);
- under **Accept payments → Advanced options**, tick **Vault** (Save payment methods), so clients can save a PayPal for their agents (`POST /v3/vault/setup-tokens` is refused without it; in production, charging a saved PayPal without the buyer also needs PayPal's approval for reference transactions);
- **Invoicing** is on by default for sandbox apps; paid receipts use it (a refused receipt is logged, never retried, and moves no money).

Save.

### 3. The partner app

Still under Apps & Credentials, create a second app on the **capital partner** business account and copy its Client ID and Secret (`PAYPAL_PARTNER_CLIENT_ID`, `PAYPAL_PARTNER_CLIENT_SECRET`). Tick **Payouts** on it too and give the partner account a balance: advances are paid out of it. Without these the advance job refuses rather than paying from the platform account.

### 4. Deploy the Blueprint on Render

1. Push the public demo repository first ([The GitHub demo repository](#the-github-demo-repository)), so the first deploy's seed names it.
2. Create a Render account at https://dashboard.render.com/register. Sign up with GitHub, or connect GitHub afterwards under Account Settings, then Git Providers.
3. Click **New → Blueprint**, pick this repository and the `main` branch. Render lists what it will create: the web service `milestone`, the database `milestone-db` and the disk `milestone-var`.
4. Render asks once for each `sync: false` variable. Fill in:
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: the platform app (step 2).
   - `PAYPAL_PARTNER_CLIENT_ID`, `PAYPAL_PARTNER_CLIENT_SECRET`: the partner app (step 3).
   - `PAYPAL_FREELANCER_EMAIL`: the freelancer personal account's email. `PAYPAL_PARTNER_EMAIL`: the capital partner business account's email.
   - `PAYPAL_WEBHOOK_ID`: you only get it after the service has a URL (step 5). Type a placeholder such as `pending` now and replace it in step 5.
   - `PAYPAL_PLATFORM_EMAIL` (optional): the platform business account's email, printed on receipts.
   - `DEMO_REPO_URL`: the https URL of the public demo repository, for example `https://github.com/<you>/landing`.
   - `ANTHROPIC_API_KEY` (optional): Claude judges the judgment criteria. Empty, those criteria go to the client, which the band says.
   - `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` (optional): pull-request deliveries, and the default branch recorded as the tamper-check baseline when a milestone is funded.
   - **Already deployed in simulated mode?** Render asks for `sync: false` variables only when a Blueprint is created. On an existing service, add the PayPal variables on the service's **Environment** page before the deploy that brings `PAYPAL_MODE=sandbox` in (or the deploy fails with the missing names). That deploy's seed finds the simulator's data and resets it to the sandbox showcase.
5. Click **Apply**. Render creates the database, builds, runs the pre-deploy command and starts the service. If any of the seven PayPal variables (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_PARTNER_CLIENT_ID`, `PAYPAL_PARTNER_CLIENT_SECRET`, `PAYPAL_FREELANCER_EMAIL`, `PAYPAL_PARTNER_EMAIL`) is empty, the deploy fails with one log line naming the missing ones (names only, never values): `start-render: PAYPAL_MODE=sandbox but ... not set; refusing to start`. The service URL is at the top of the service page (for example `https://milestone-xxxx.onrender.com`).

### 5. The webhook

PayPal must reach the service, or nothing is ever Released (rule 7: a milestone is Released only when PayPal's webhook confirms the payout).

1. In the Developer Dashboard, open the **platform** app, then **Add Webhook**, with the URL **`<render url>/api/webhooks/paypal`** (for example `https://milestone-xxxx.onrender.com/api/webhooks/paypal`).
2. Subscribe to these events:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.PAYOUTSBATCH.DENIED`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.FAILED`, `.BLOCKED`, `.DENIED`, `.CANCELED`, `.UNCLAIMED`, `.HELD`, `.RETURNED`, `.REVERSED`, `.REFUNDED`
   - `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`
   - `INVOICING.INVOICE.PAID` (stored in the audit log only)
   - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED` (recorded; saving a PayPal does not depend on them)
3. Save and copy the webhook's **ID**. On the Render service's **Environment** page, set `PAYPAL_WEBHOOK_ID` to it and save (this redeploys). Every incoming event is signature-checked with PayPal against this id and de-duplicated by event id; an event that fails the check is answered 400 and never read.

The partner app needs no webhook: advance payouts are recorded when PayPal accepts the batch.

### 6. Check it

1. Open the service URL. The band says "real PayPal sandbox"; the signup-flow contract's three milestones are drafts.
2. As **Client**, click PayPal's button on milestone 1 and pay with the buyer account. The milestone turns Funded.
3. As **Freelancer**, deliver it from `DEMO_REPO_URL`, branch `m1-pass`; when the verdict lands, approve as the client (or let the review window close). Within a minute or two PayPal's `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhook arrives and the milestone turns Released. If it stays at "releasing", check the webhook's URL and event list in the Developer Dashboard (its **Webhooks Events** page shows each delivery and PayPal's response) and the service log.
4. Click **Reset demo** before handing it to judges. It resets the database only.

Costs: the web service is on the `1c-2g` plan and the database on `0.1c-256mb`, plus the 1 GB disk. The free plan cannot attach a disk or run a pre-deploy command, so the Blueprint does not use it. `0.5c-512mb` is enough to browse, but it can run out of memory while the worker runs a delivered repository's `npm install` and test suite.

## Simulated mode (no PayPal account)

`PAYPAL_MODE=simulated` swaps PayPal for a built-in simulator that answers the same REST calls and posts its own webhooks (authenticated with `SIMULATED_WEBHOOK_SECRET`, which the Blueprint generates). It needs no PayPal variable at all, and its showcase has every state live, including Casey's saved PayPal and an armed payout failure for the operator beat (`POST /api/dev/paypal/fail`). It is the default for a local run without keys (README, Quick start), and the hosted service can be switched to it by setting `PAYPAL_MODE=simulated` on the Environment page.

Switching modes in either direction resets the data on the next deploy: the pre-deploy seed runs with `--reset-if-other-mode`, which finds PayPal ids that belong to the other mode (simulator ids outside the recorded showcase on the sandbox, real ids under the simulator), truncates and rebuilds the showcase for the new mode, and says so in the deploy log.

## What a deploy does

Build (`buildCommand`): `corepack enable` provides the pnpm version pinned in `package.json`. Then `pnpm install --frozen-lockfile` runs with dev dependencies, because `tsx` (which runs the worker and the seed) and `drizzle-kit` (migrations) are needed at run time, and `pnpm --filter @milestone/web build` builds the app.

Pre-deploy (`preDeployCommand`, `node scripts/start-render.mjs predeploy`), on every deploy:

1. In sandbox mode, the seven PayPal variables are checked (the deploy fails, naming the missing ones), and `PAYPAL_ENV=live` is refused.
2. `drizzle-kit migrate` applies any new migrations.
3. `seed --showcase --if-empty --reset-if-other-mode` seeds the demo when the `users` table is empty (the **first deploy**), or resets and reseeds it when its data belongs to the other PayPal mode. On the sandbox the showcase is: three contracts (plus one the PayPal AUP check flags), the signup-flow contract's three milestones as drafts, and the recorded states described above; in simulated mode every milestone state is live (funded, in review with the window open and its release job queued, released with a repaid advance, waiting on the client, held after a failed payout, a second client's funded milestone with an open advance) plus Casey's saved PayPal. Later deploys in the same mode leave the data alone. Use Reset demo to start over.

Start (`startCommand`, `node scripts/start-render.mjs`): checks the PayPal variables again, sets `APP_URL` from `RENDER_EXTERNAL_URL` when it is not set (PayPal's return links and agent links use it), puts the https-only `git` first on `PATH`, then starts `next start` on Render's `PORT` and the worker. If either process exits, the script stops the other and exits, and Render restarts the service.

The disk is mounted at `/var/data`. It holds uploaded deliveries (`UPLOAD_DIR`), npm's cache for verification runs (`MILESTONE_NPM_CACHE`) and, in simulated mode, the simulator's state (`SIMULATED_PAYPAL_STATE_FILE`), so a restart keeps them. A service with a disk cannot scale beyond one instance. The demo needs only one.

The health check is `GET /api/dev/paypal/mode`. It answers with the PayPal mode and does not touch the database or PayPal.

## Recording the video against the hosted demo

Payout confirmations need PayPal's webhook to reach the app, so the real video is recorded against the deployed service, not a local run:

```bash
SANDBOX_CLIENT_EMAIL=... SANDBOX_CLIENT_PASSWORD=... \
  node scripts/record-demo.mjs --app-url https://milestone-xxxx.onrender.com \
    --database-url "<Render: milestone-db, Connections, External Database URL>" \
    --repo-url https://github.com/<you>/landing --reset
```

The recorder drives the deployed app in Chrome, funds through PayPal's real checkout (it clicks PayPal's button, logs in as the sandbox buyer in PayPal's window and approves), and reads the database only to wait for states. The buyer's credentials are read from the environment and typed into PayPal's fields only, never logged. `--headed` shows the browser window. Beats that need the simulator (the bakery upload with an armed payout failure) are left out on the sandbox; the operator beat shows the recorded held case instead.

## The GitHub demo repository

The hosted worker clones over https and needs no credentials, so the repository it verifies must be **public**. The demo repository lives in `fixtures/demo-repo`. To publish it:

1. On GitHub, create a new **public**, **empty** repository (no README, licence or .gitignore), for example `landing`.
2. From a checkout of this repository, run:

   ```bash
   scripts/render-push-demo-repo.sh https://github.com/<you>/landing.git
   ```

   The script builds the repository with `scripts/make-demo-repo.sh` and pushes `main` and three delivery branches: `m1-pass` (passes), `m2-partial` (the client's discount test fails) and `m2-injection` (a commit message that tries to instruct the verifier). It never force-pushes. It then checks that an anonymous clone works, as it will on Render.
3. On the Render service's Environment page, set `DEMO_REPO_URL` to `https://github.com/<you>/landing` and save (this redeploys). The hosted demo accepts code deliveries from this repository only; see [What the hosted demo is](#what-the-hosted-demo-is).
4. In the demo, fund a signup-flow milestone as the client (PayPal checkout), then switch to Freelancer and deliver it. The deliver form suggests `DEMO_REPO_URL`; set the branch to one of the three above.

The seed names the demo contract's repository after `DEMO_REPO_URL` when it is a github.com URL, and falls back to `milestone-demo/landing` otherwise. A database seeded before you set it keeps the old name until you click **Reset demo**; the deliver form suggests `DEMO_REPO_URL` either way, and only that repository is accepted.

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
| `SPIKE_FREELANCER_EMAIL` | Leave unset | Fallback for `PAYPAL_FREELANCER_EMAIL`, used by the local money spike. |
| `PAYPAL_MCP_RESOLVE_FROM` | Leave unset | Where the PayPal MCP server is resolved from. Found automatically. |
| `REVIEW_WINDOW_SECONDS` | Optional | Overrides every contract's client review window (minimum 30 s). Useful for a fast live demo. |
| `RECONCILE_WINDOW_HOURS` | Optional | The reconciliation job's look-back window. |
| `RECONCILE_LAG_HOURS` | Optional | How far behind the present reconciliation stops, so PayPal's reporting can catch up. |

Platform variables that Render provides and the code reads: `PORT`, `RENDER_EXTERNAL_URL`, `NODE_ENV` (set to `production` in the Blueprint), `PATH` and `HOME`.

## Known limits of the hosted demo

- Delivered code runs on the service's host under the service's user, with network access. Only the child environment is cleaned (see CLAUDE.md, "Known limitation"). That is why hosted deliveries are limited to public https repositories, but it is still not a sandbox. A real deployment needs a container or microVM per verification.
- Anyone with the URL can switch roles, act on milestones and reset the demo. That is intended for judging.
- Reset demo truncates every table. Contracts that visitors created are lost, and the showcase is rebuilt. On the real sandbox it cannot reset PayPal: orders, captures, payouts and refunds stay in the sandbox accounts' history, and the platform account's balance goes down with every payout (see step 5 of the owner's steps).
- The showcase's other states (the bakery's partial verdict and held payout, the second client's funded milestone and open advance) are recorded with simulator ids, so on the real sandbox they are display only and marked "recorded for the showcase". The money path is live on the signup-flow contract and on anything a visitor creates.
- A sandbox payout can stay `UNCLAIMED` or `PENDING` for a while; the milestone shows "releasing" until PayPal's webhook says it succeeded (CLAUDE.md rule 7).
