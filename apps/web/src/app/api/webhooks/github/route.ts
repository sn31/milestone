import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { storeWebhookOnce, enqueue, deliveries } from "@milestone/core";
import { getDb } from "@/lib/db";

function verify(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

type PullRequestPayload = {
  action?: string;
  pull_request?: { merged?: boolean; number: number; merge_commit_sha?: string | null; title?: string | null; body?: string | null; head?: { ref?: string }; base?: { sha?: string | null } };
  repository?: { full_name?: string; clone_url?: string };
};

/** Branch "m2-partial" -> milestone seq 2. */
function seqFromBranch(branch: string | undefined): number | null {
  const m = /^m(\d+)-/.exec(branch ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Repository webhook: a merged pull request becomes a delivery and a verify job. */
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return new Response("GITHUB_WEBHOOK_SECRET not set", { status: 500 });
  if (!verify(raw, req.headers.get("x-hub-signature-256"), secret)) return new Response("bad signature", { status: 400 });

  const eventId = req.headers.get("x-github-delivery") ?? "";
  const eventType = req.headers.get("x-github-event") ?? "";
  const payload = JSON.parse(raw) as PullRequestPayload;

  const db = getDb();
  const fresh = await storeWebhookOnce(db, { source: "github", eventId, type: `${eventType}.${payload.action ?? ""}`, payload });
  if (!fresh) return Response.json({ duplicate: true });

  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;
  const cloneUrl = payload.repository?.clone_url;
  const sha = pr?.merge_commit_sha;
  const seq = seqFromBranch(pr?.head?.ref);
  if (eventType !== "pull_request" || payload.action !== "closed" || !pr?.merged || !repoFullName || !cloneUrl || !sha || seq === null) {
    return Response.json({ ignored: true });
  }

  const contractIds = (await db.query.contracts.findMany({ where: (c, { eq }) => eq(c.repoFullName, repoFullName), columns: { id: true } })).map((c) => c.id);
  if (contractIds.length === 0) return Response.json({ ignored: true });
  const milestone = await db.query.milestones.findFirst({
    where: (m, { and, eq, inArray }) => and(inArray(m.contractId, contractIds), eq(m.seq, seq), inArray(m.status, ["funded", "held"])),
    columns: { id: true },
  });
  if (!milestone) return Response.json({ ignored: true });

  // Same milestone + same merge commit = same delivery, so a redelivered webhook cannot create a second row.
  const deliveryId = `dlv_${createHash("sha256").update(`${milestone.id}:${sha}`).digest("hex").slice(0, 24)}`;
  await db.insert(deliveries).values({
    id: deliveryId,
    milestoneId: milestone.id,
    source: "github_pr",
    ref: `${repoFullName}#${pr.number}`,
    // base_sha: the tamper check's baseline when no funding-time baseline was recorded on the milestone.
    payload: { sha, title: pr.title ?? "", body: pr.body ?? "", branch: pr.head?.ref ?? "", clone_url: cloneUrl, pr_number: pr.number, repo: repoFullName, base_sha: typeof pr.base?.sha === "string" ? pr.base.sha : null },
  }).onConflictDoNothing();
  await enqueue("verify", milestone.id, { deliveryId }, { dedupe: sha });
  return Response.json({ ok: true, milestoneId: milestone.id, deliveryId });
}
