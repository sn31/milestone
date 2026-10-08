// The demo beats from docs/video-script.md, driven through the real UI. Each beat gets a short hold at the end so the
// state it reached is on screen long enough to cut. Off-camera setup (funding a milestone the script funds "off
// camera", arming the payout failure) runs with the recorder paused, so it is not in the video.
import { sleep } from "./cdp.mjs";

const M1 = "Signup form and validation";
const M2 = "Account creation API and confirmation page";
const BRAND1 = "Logo and colour system";
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
  return waitStatus(ctx, id, DONE_STATES, 30_000);
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
    id: "deliver-release",
    title: "Deliver m1-pass, verify, approve, release",
    script: "Deliver and release, 0:45 to 1:20",
    async run(ctx) {
      const { d } = ctx;
      const before = verified(ctx, "mst_1");
      await deliver(ctx, M1, "m1-pass");
      await waitStatus(ctx, "mst_1", ["verifying", ...DONE_STATES], 30_000);
      const s = await waitVerdict(ctx, "mst_1", before);
      ctx.note(`m1-pass verdict: ${s}`);
      await d.role("usr_client");
      await catchUp(ctx, M1, s);
      await unfold(ctx, M1);
      await sleep(ctx.holdMs);
      if (s === "review") {
        // The window closes on its own; stay on the countdown.
        await waitStatus(ctx, "mst_1", ["released", "held", "partial_released"], ctx.reviewSeconds * 1000 + 90_000);
      } else if (s === "needs_client") {
        await d.click({ within: M1, text: "Approve in full" });
        await waitStatus(ctx, "mst_1", ["released", "held", "partial_released"], 90_000);
      } else {
        throw new Error(`m1-pass ended ${s}, expected review or needs_client`);
      }
      const end = status(ctx, "mst_1");
      ctx.note(`mst_1 after release: ${end}`);
      await catchUp(ctx, M1, end, 8000);
    },
  },
  {
    id: "hold",
    title: "Milestone 2: m2-partial held, then m2-injection flagged",
    script: "The hold, 1:20 to 1:50",
    async run(ctx) {
      const { d } = ctx;
      await ctx.offCamera(async () => {
        await fund(ctx, M2, "mst_2");
      });
      let before = verified(ctx, "mst_2");
      await deliver(ctx, M2, "m2-partial");
      let s = await waitVerdict(ctx, "mst_2", before);
      ctx.note(`m2-partial: ${s}`);
      await catchUp(ctx, M2, s);
      await unfold(ctx, M2);
      await sleep(ctx.holdMs);
      before = verified(ctx, "mst_2");
      await deliver(ctx, M2, "m2-injection");
      s = await waitVerdict(ctx, "mst_2", before);
      const inj = ctx.db("select suspected_injection from deliveries where milestone_id='mst_2' order by created_at desc limit 1");
      ctx.note(`m2-injection: ${s}, suspected_injection=${inj}`);
      await d.role("usr_client");
      await catchUp(ctx, M2, s);
      await d.show({ within: M2, selector: "*", text: M2 }, "start").catch(() => {});
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
      const s = await waitVerdict(ctx, "mst_brand_1", before);
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
      } else if (s !== "review") {
        throw new Error(`bakery milestone is ${s}; expected needs_client or review`);
      }
      await waitDb(ctx, "select count(*) from audit_log where milestone_id='mst_brand_1' and event='milestone.needs_operator'", (n) => Number(n) > 0, {
        timeout: ctx.reviewSeconds * 1000 + 90_000,
        what: "milestone.needs_operator on mst_brand_1",
      });
      ctx.note(`mst_brand_1 after the failed payout: ${status(ctx, "mst_brand_1")}`);
      await catchUp(ctx, BRAND1, status(ctx, "mst_brand_1"));
      await d.show({ within: BRAND1, selector: "*", text: BRAND1 }, "start").catch(() => {});
      await sleep(ctx.holdMs);
      await d.role("usr_partner");
      await d.go("/ops");
      await sleep(ctx.holdMs);
      await d.type({ selector: "input[placeholder^='Paid the freelancer']" }, "Freelancer fixed their PayPal email; paid by hand, batch DEMO-1.");
      await d.click({ text: "Mark resolved" });
      await waitDb(ctx, "select count(*) from audit_log where milestone_id='mst_brand_1' and event='ops.resolved'", (n) => Number(n) > 0, { timeout: 30_000, what: "ops.resolved" });
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
