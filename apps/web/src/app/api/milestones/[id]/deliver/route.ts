import { AUDIT_EVENTS, DELIVERABLE_STATUSES, audit, commitDeliveryId, deliveries, enqueue, type CommitPayload } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractFreelancer } from "@/lib/session";
import { loadMilestone } from "../../_shared";
import { checkRepoUrl, resolveRef, validRef } from "./resolve";

/**
 * Manual repository delivery by the contract's freelancer: { repoUrl, ref, title?, note? }. The ref is resolved to a
 * commit with git ls-remote and the delivery gets the GitHub webhook's payload shape, so the verify job treats it
 * exactly like a merged pull request (clone_url + sha, tamper check against the milestone's baseline).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c } = found;
  if (!isContractFreelancer(actor, c)) return jsonError("only the contract's freelancer can deliver", 403);
  if (!DELIVERABLE_STATUSES.has(m.status)) return jsonError(`cannot deliver while milestone is ${m.status}`, 409);

  const body = (await req.json().catch(() => null)) as { repoUrl?: unknown; ref?: unknown; title?: unknown; note?: unknown } | null;
  // Local repositories (file://, absolute paths) only where localReposAllowed says so; see resolve.ts.
  const checked = checkRepoUrl(typeof body?.repoUrl === "string" ? body.repoUrl : "");
  if (!checked.ok) return jsonError(checked.reason, 400);
  const repoUrl = checked.url;
  const ref = typeof body?.ref === "string" && body.ref.trim() ? body.ref.trim() : "HEAD";
  if (!validRef(ref)) return jsonError("ref must be a branch, tag, HEAD or a 40-character commit id", 400);

  const resolved = await resolveRef(repoUrl, ref);
  if (!resolved.ok) return jsonError(resolved.error, 422);
  const sha = resolved.sha;

  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : `Manual delivery of ${ref}`;
  const note = typeof body?.note === "string" ? body.note.slice(0, 10_000) : "";
  const deliveryId = commitDeliveryId(m.id, sha);
  // The GitHub webhook's shape; base_sha is the tamper check's baseline (the milestone's funding-time head).
  const payload: CommitPayload = { sha, title, body: note, branch: ref, clone_url: repoUrl, repo: repoUrl, base_sha: m.baselineSha ?? null };
  const inserted = await db
    .insert(deliveries)
    .values({
      id: deliveryId,
      milestoneId: m.id,
      source: "manual",
      ref: `${repoUrl}@${ref}`,
      payload,
    })
    .onConflictDoNothing()
    .returning({ id: deliveries.id });
  if (inserted.length) {
    await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.deliveryManual, milestoneId: m.id, contractId: c.id, detail: { deliveryId, repoUrl, ref, sha } });
  }
  await enqueue("verify", m.id, { deliveryId }, { dedupe: sha });
  return json({ ok: true, deliveryId, sha, duplicate: inserted.length === 0 });
}
