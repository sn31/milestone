// The demo beats from docs/video-script.md, driven through the real UI. Each beat gets a short hold at the end so the
// state it reached is on screen long enough to cut. Off-camera setup (funding a milestone the script funds "off
// camera", arming the payout failure) runs with the recorder paused, so it is not in the video.
import { sleep } from "./cdp.mjs";

const M1 = "Signup form and validation";
const M2 = "Account creation API and confirmation page";
const BRAND1 = "Logo and colour system";
const AGENT_NAME = "Casey's agent";
const REPO_INPUT = "input[placeholder='https://github.com/you/repo.git']";
const BRANCH_INPUT = "input[placeholder=main]";
const DONE_STATES = ["review", "needs_client", "held", "released", "partial_released"];

/** Waits until `sql` (one value) satisfies `ok`. */
async function waitDb(ctx, sql, ok, { timeout = 60_000, what = sql } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = ctx.db(sql);
    if (ok(last)) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(500);
  }
}
const status = (ctx, id) => ctx.db(`select status from milestones where id='${id}'`);
const waitStatus = (ctx, id, states, timeout = 90_000) =>
  waitDb(ctx, `select status from milestones where id='${id}'`, (s) => states.includes(s), { timeout, what: `${id} in ${states.join("|")}` });

// Station tone per milestone status (apps/web/src/components/ui/states.ts): each rail <li> carries data-tone.
const TONE = { draft: "draft", funded: "funded", verifying: "verifying", review: "review", released: "released", partial_released: "partial", held: "held", needs_client: "needs" };

/** Waits for the station of `title` to show `status`; reloads the page when it has not caught up with the server. */
async function catchUp(ctx, title, statusNow, ms = 6000) {
  const expr = `(() => { const li = [...document.querySelectorAll('ol[aria-label$=": milestones"] > li')].find((l) => l.innerText.includes(${JSON.stringify(title)})); return !!li && li.dataset.tone === ${JSON.stringify(TONE[statusNow] ?? statusNow)}; })()`;
  try { await ctx.d.waitFor(expr, { timeout: ms, what: `${title} showing ${statusNow}` }); } catch { await ctx.d.reload(); }
}

/** Opens the station's folded verdict receipt (criteria, evidence, tamper note) and brings it on screen. */
async function unfold(ctx, title) {
  const { d } = ctx;
  try {
    // A receipt opened earlier stays open across role switches (client state survives the re-render).
    const open = await d.eval(`!!window.__demo.find(${JSON.stringify({ within: title, selector: "button[aria-expanded=true]", text: "receipt" })})`);
    if (!open) {
      await d.click({ within: title, selector: "button[aria-expanded=false]", text: "receipt" }, { timeout: 8000 });
      await sleep(700);
    }
    await d.show({ within: title, selector: "button[aria-expanded=true]" }, "start");
  } catch (e) {
    ctx.note(`no receipt to unfold on "${title}": ${e.message}`);
  }
}

/** Client funds a milestone with the simulated PayPal button (create order, approve page, back, capture). */
async function fund(ctx, title, id) {
  const { d } = ctx;
  await d.role("usr_client");
  await d.click({ within: title, text: "Fund" });
  await waitStatus(ctx, id, ["funded"], 60_000);
  await d.settle(1200);
}

/** Freelancer delivers a branch of the demo repo with the Deliver form on the milestone. */
async function deliver(ctx, title, branch) {
  const { d } = ctx;
  await d.role("usr_freelancer");
  await d.type({ within: title, selector: REPO_INPUT }, ctx.repoPath);
  await d.type({ within: title, selector: BRANCH_INPUT }, branch);
  await sleep(400);
  await d.click({ within: title, text: "Deliver commit" });
}

const verified = (ctx, id) => Number(ctx.db(`select count(*) from deliveries where milestone_id='${id}' and verified_at is not null`));

/** Waits for the next verdict on `id` (one more verified delivery than `before`) and a settled status. */
async function waitVerdict(ctx, id, before, timeout = 180_000) {
  await waitDb(ctx, `select count(*) from deliveries where milestone_id='${id}' and verified_at is not null`, (n) => Number(n) > before, { timeout, what: `verdict on ${id}` });
  // For timing the takes: who judged, how long the verification took, and each criterion's status with its evidence count.
  ctx.note(`verified ${id}: ${ctx.db(`select coalesce(d.model, '?') || ' in ' || round(extract(epoch from d.verified_at - d.created_at)::numeric, 1) || 's, ' || d.result || ': ' || coalesce((select string_agg((c->>'criterion_id') || '=' || (c->>'status') || '[' || jsonb_array_length(c->'evidence_ids') || ' ev]', ' ') from jsonb_array_elements(d.verdict->'criteria') c), '') from deliveries d where d.milestone_id='${id}' and d.verified_at is not null order by d.created_at desc limit 1`)}`);
  return waitStatus(ctx, id, DONE_STATES, 30_000);
}


/**
 * Casey saves her PayPal on /agents (the simulator approves the setup token at once), then gets a mandate through the
 * API: read, fund, approve and hold; approve, per-milestone fund and total fund caps of $200.00; auto-fund the next
 * milestone. The mandate call is the one an API client makes (POST /api/agents with the role cookie).
 */
async function agentSetup(ctx) {
  const { d } = ctx;
  await d.role("usr_client");
  await d.go("/agents");
  await sleep(1000);
  await d.click({ text: "Save PayPal for agent payments" });
  await waitDb(ctx, "select count(*) from payment_methods where user_id='usr_client' and removed_at is null", (n) => Number(n) > 0, { timeout: 60_000, what: "Casey's saved PayPal" });
  ctx.mark("saved");
  ctx.note(`saved PayPal: ${ctx.db("select paypal_payment_token_id from payment_methods where user_id='usr_client' and removed_at is null limit 1")}`);
  await d.go("/agents");
  await sleep(1000);
  const body = JSON.stringify({ agentName: AGENT_NAME, actions: ["read", "fund", "approve", "hold"], approveCapMinor: 20000, fundCapMinor: 20000, fundTotalCapMinor: 20000, autoFundNext: true, currency: "USD", expiresInDays: 30 });
  const code = await d.eval(`fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(body)} }).then((r) => r.status)`);
  if (code !== 201 && code !== 200) throw new Error(`creating the mandate answered HTTP ${code}`);
  ctx.note(`mandate created (HTTP ${code}): auto-fund next, caps $200.00`);
  await d.reload();
  await sleep(800);
  ctx.mark("mandate");
}

export const BEATS = [
  {
    id: "hook",
    title: "Home: the contract ledger",
    script: "Hook, 0:00 to 0:15",
    async run(ctx) {
      await ctx.d.go("/");
      await ctx.d.role("usr_client");
      await ctx.d.moveCursor(900, 300, 400);
    },
  },
  {
    id: "fund",
    title: "Client funds milestone 1 with simulated PayPal",
    script: "Fund, 0:15 to 0:30",
    async run(ctx) {
      const { d } = ctx;
      await d.go("/contracts/ctr_demo");
      await d.role("usr_client");
      await sleep(1200);
      await fund(ctx, M1, "mst_1");
    },
  },
  {
    id: "advance",
    title: "Freelancer takes the advance: Get paid now",
    script: "Get paid now, 0:30 to 0:45",
    async run(ctx) {
      const { d } = ctx;
      await d.role("usr_freelancer");
      await d.click({ within: M1, text: "Get paid now" });
      await waitDb(ctx, "select status from advances where milestone_id='mst_1'", (s) => s === "funded" || s === "repaid", { timeout: 60_000, what: "advance funded" });
      await d.settle(1500);
    },
  },
  {
    id: "agent-setup",
    title: "Casey saves her PayPal and gives her agent a $200 mandate with auto-fund",
    script: "The client's agent, 0:56 to 1:14 (setup)",
    async run(ctx) {
      await agentSetup(ctx);
      // The saved PayPal and, below it, the new mandate row (Casey's agent, $200.00, funds the next milestone on release).
      await ctx.d.show({ selector: "#saved-paypal" }, "start");
    },
  },
  {
    id: "deliver-release",
    title: "Deliver m1-pass, verify, approve, release",
    script: "Deliver and release, 0:45 to 1:20",
    async run(ctx) {
      const { d } = ctx;
      await d.go("/contracts/ctr_demo");
      const before = verified(ctx, "mst_1");
      await deliver(ctx, M1, "m1-pass");
      ctx.mark("delivered");
      await waitStatus(ctx, "mst_1", ["verifying", ...DONE_STATES], 30_000);
      const s = await waitVerdict(ctx, "mst_1", before);
      ctx.mark("verdict");
      ctx.note(`m1-pass verdict: ${s}`);
      await d.role("usr_client");
      await catchUp(ctx, M1, s);
      await unfold(ctx, M1);
      ctx.mark("receipt");
      await sleep(ctx.holdMs);
      if (s === "review") {
        // The window closes on its own; back up to the countdown band (Approve now, Veto release) and stay on it.
        await d.show({ within: M1, text: "Approve now" }, "center").catch((e) => ctx.note(`no countdown band: ${e.message}`));
        ctx.mark("countdown");
        await waitStatus(ctx, "mst_1", ["released", "held", "partial_released"], ctx.reviewSeconds * 1000 + 90_000);
      } else if (s === "needs_client") {
        await d.click({ within: M1, text: "Approve in full" });
        await waitStatus(ctx, "mst_1", ["released", "held", "partial_released"], 90_000);
      } else {
        throw new Error(`m1-pass ended ${s}, expected review or needs_client`);
      }
      ctx.mark("released");
      const end = status(ctx, "mst_1");
      ctx.note(`mst_1 after release: ${end}`);
      await catchUp(ctx, M1, end, 8000);
    },
  },
  {
    id: "agent-fund",
    title: "Milestone 1 released, so the agent funds milestone 2 from Casey's saved PayPal",
    script: "The client's agent, 0:56 to 1:14",
    async run(ctx) {
      const { d } = ctx;
      // The release job's auto-fund rule charges the vault once mst_1 is released; nothing here calls a model.
      await d.role("usr_client");
      await d.go("/contracts/ctr_demo");
      await waitDb(ctx, "select count(*) from audit_log where milestone_id='mst_2' and event='paypal.vault_charge'", (n) => Number(n) > 0, { timeout: 90_000, what: "paypal.vault_charge on mst_2" });
      await waitStatus(ctx, "mst_2", ["funded"], 60_000);
      ctx.mark("funded");
      ctx.note(`agent.autofund: ${ctx.db("select detail->>'outcome' from audit_log where milestone_id='mst_2' and event='agent.autofund' order by created_at desc limit 1")}`);
      ctx.note(`mst_2 funded by the agent; actor: ${ctx.db("select actor from audit_log where milestone_id='mst_2' and event='paypal.vault_charge' order by created_at desc limit 1")}`);
      await catchUp(ctx, M2, "funded", 8000);
      await d.show({ within: M2, selector: "*", text: M2 }, "start").catch(() => {});
      await sleep(ctx.holdMs);
      await d.go("/agents");
      ctx.mark("agents");
      await sleep(1500);
      // The mandate row (fund meter now $100.00 of $200.00) and, below it, the paypal.vault_charge row by the agent.
      await d.show({ selector: "#agent-activity-title" }, "center");
    },
  },
  {
    id: "hold",
    title: "Milestone 2: m2-partial held, then m2-injection flagged",
    script: "The hold, 1:20 to 1:50",
    async run(ctx) {
      const { d } = ctx;
      await d.go("/contracts/ctr_demo");
      // With the agent beat run, mst_2 is already funded (by the agent); otherwise the client funds it off camera.
      if (status(ctx, "mst_2") === "draft") {
        await ctx.offCamera(async () => {
          await fund(ctx, M2, "mst_2");
        });
      }
      let before = verified(ctx, "mst_2");
      await deliver(ctx, M2, "m2-partial");
      ctx.mark("partial-delivered");
      let s = await waitVerdict(ctx, "mst_2", before);
      ctx.mark("partial-verdict");
      ctx.note(`m2-partial: ${s}`);
      await catchUp(ctx, M2, s);
      await unfold(ctx, M2);
      await sleep(ctx.holdMs);
      before = verified(ctx, "mst_2");
      await deliver(ctx, M2, "m2-injection");
      ctx.mark("injection-delivered");
      s = await waitVerdict(ctx, "mst_2", before);
      ctx.mark("injection-verdict");
      const inj = ctx.db("select suspected_injection from deliveries where milestone_id='mst_2' order by created_at desc limit 1");
      ctx.note(`m2-injection: ${s}, suspected_injection=${inj}`);
      await d.role("usr_client");
      await catchUp(ctx, M2, s);
      await d.show({ within: M2, selector: "*", text: M2 }, "start").catch(() => {});
      ctx.mark("flagged");
      await sleep(ctx.holdMs);
      await unfold(ctx, M2);
    },
  },
  {
    id: "files",
    title: "Bakery: upload a logo and a PDF style guide",
    script: "Files too, 1:50 to 2:00",
    async run(ctx) {
      const { d } = ctx;
      await ctx.offCamera(async () => {
        await d.go("/contracts/ctr_brand");
        await fund(ctx, BRAND1, "mst_brand_1");
        // Arms the operator beat: the next freelancer payout item for this milestone comes back FAILED.
        const armed = await d.eval(`fetch("/api/dev/paypal/fail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ milestoneId: "mst_brand_1", party: "freelancer", reason: "RECEIVER_UNREGISTERED" }) }).then((r) => r.status)`);
        ctx.note(`armed payout failure for mst_brand_1:freelancer -> HTTP ${armed}`);
        await d.role("usr_freelancer");
        await d.scrollTop();
      });
      const before = verified(ctx, "mst_brand_1");
      await d.upload("input[type=file]", ctx.uploadFiles);
      await sleep(900);
      await d.click({ within: BRAND1, text: "Upload and verify" });
      ctx.mark("uploaded");
      const s = await waitVerdict(ctx, "mst_brand_1", before);
      ctx.mark("verdict");
      ctx.note(`bakery upload: ${s}`);
      await d.role("usr_client");
      await catchUp(ctx, BRAND1, s);
      await unfold(ctx, BRAND1);
    },
  },
  {
    id: "lender",
    title: "The lender's book at /lender",
    script: "Under the hood, 2:00 to 2:50",
    async run(ctx) {
      const { d } = ctx;
      await d.role("usr_partner");
      await d.go("/lender");
      await sleep(1500);
      await d.eval(`window.scrollTo({ top: Math.min(document.body.scrollHeight, 520), behavior: "smooth" })`);
    },
  },
  {
    id: "activity",
    title: "Audit grid on /contracts/ctr_demo/activity",
    script: "Under the hood, 2:00 to 2:50",
    async run(ctx) {
      await ctx.d.go("/contracts/ctr_demo/activity");
      await sleep(1500);
    },
  },
  {
    id: "ops",
    title: "Armed payout failure: bakery release held, resolved on /ops",
    script: "Under the hood (optional beat)",
    async run(ctx) {
      const { d } = ctx;
      await d.go("/contracts/ctr_brand");
      await d.role("usr_client");
      const s = status(ctx, "mst_brand_1");
      if (s === "needs_client") {
        await d.click({ within: BRAND1, text: "Approve in full" });
        ctx.mark("approved");
      } else if (s !== "review") {
        throw new Error(`bakery milestone is ${s}; expected needs_client or review`);
      }
      await waitDb(ctx, "select count(*) from audit_log where milestone_id='mst_brand_1' and event='milestone.needs_operator'", (n) => Number(n) > 0, {
        timeout: ctx.reviewSeconds * 1000 + 90_000,
        what: "milestone.needs_operator on mst_brand_1",
      });
      ctx.mark("needs-operator");
      ctx.note(`mst_brand_1 after the failed payout: ${status(ctx, "mst_brand_1")}`);
      await catchUp(ctx, BRAND1, status(ctx, "mst_brand_1"));
      await d.show({ within: BRAND1, selector: "*", text: BRAND1 }, "start").catch(() => {});
      await sleep(ctx.holdMs);
      await d.role("usr_partner");
      await d.go("/ops");
      ctx.mark("ops");
      await sleep(ctx.holdMs);
      await d.type({ selector: "input[placeholder^='Paid the freelancer']" }, "Freelancer fixed their PayPal email; paid by hand, batch DEMO-1.");
      await d.click({ text: "Mark resolved" });
      await waitDb(ctx, "select count(*) from audit_log where milestone_id='mst_brand_1' and event='ops.resolved'", (n) => Number(n) > 0, { timeout: 30_000, what: "ops.resolved" });
      ctx.mark("resolved");
      await sleep(1200);
      await d.reload();
    },
  },
  {
    id: "close",
    title: "Back to the ledger",
    script: "Close, 2:50 to 3:00",
    async run(ctx) {
      await ctx.d.role("usr_client");
      await ctx.d.go("/");
    },
  },
];
