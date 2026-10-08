import { createHmac, timingSafeEqual } from "node:crypto";
import { storeWebhookOnce, enqueue } from "@milestone/core";
import { getDb } from "@/lib/db";

function verify(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Repository webhook: a merged pull request becomes a delivery and a verify job. */
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return new Response("GITHUB_WEBHOOK_SECRET not set", { status: 500 });
  if (!verify(raw, req.headers.get("x-hub-signature-256"), secret)) return new Response("bad signature", { status: 400 });

  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  const eventType = req.headers.get("x-github-event") ?? "";
  const payload = JSON.parse(raw) as { action?: string; pull_request?: { merged?: boolean; number: number; merge_commit_sha?: string; title?: string; body?: string; head?: { ref?: string } }; repository?: { full_name?: string; clone_url?: string } };

  const fresh = await storeWebhookOnce(getDb(), { source: "github", eventId: deliveryId, type: `${eventType}.${payload.action ?? ""}`, payload });
  if (!fresh) return Response.json({ duplicate: true });

  if (eventType === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
    // Oct 15: look up the milestone by repository + branch naming (e.g. branch "m2-*" -> milestone seq 2) and create the delivery row.
    const pr = payload.pull_request;
    const milestoneId = `TODO:${payload.repository?.full_name}#${pr.number}`;
    await enqueue("verify", milestoneId, { repo: payload.repository?.clone_url, sha: pr.merge_commit_sha, prNumber: pr.number, title: pr.title, body: pr.body, branch: pr.head?.ref }, { dedupe: String(pr.merge_commit_sha) });
  }
  return Response.json({ ok: true });
}
