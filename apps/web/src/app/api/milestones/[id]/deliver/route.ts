import { AUDIT_EVENTS, DELIVERABLE_STATUSES, audit, checkDemoRepo, commitDeliveryId, demoModeOn, deliveries, enqueue, type CommitPayload } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractFreelancer } from "@/lib/session";
import { loadMilestone } from "../../_shared";
import { checkRepoUrl, resolveRef, validRef } from "./resolve";
import { RATE_RULES, limitResponse } from "@/lib/rate-limit";

/**
 * Manual repository delivery by the contract's freelancer: { repoUrl, ref, title?, note? }. The ref is resolved to a
 * commit with git ls-remote and the delivery gets the GitHub webhook's payload shape, so the verify job treats it
 * exactly like a merged pull request (clone_url + sha, tamper check against the milestone's baseline).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Each delivery queues a worker judgment; deliver and upload share one per-IP bucket (DEMO_MODE only).
  const limited = limitResponse(req, RATE_RULES.delivery);
  if (limited) return limited;
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c } = found;
  if (!isContractFreelancer(actor, c)) return jsonError("only the contract's freelancer can deliver", 403);
  if (!DELIVERABLE_STATUSES.has(m.status)) return jsonError(`cannot deliver while milestone is ${m.status}`, 409);

  const body = (await req.json().catch(() => null)) as { repoUrl?: unknown; ref?: unknown; title?: unknown; note?: unknown } | null;
  const rawRepoUrl = typeof body?.repoUrl === "string" ? body.repoUrl : "";
  // DEMO_MODE: code from the demo repository only (delivered code runs unsandboxed on the worker host). Refused before
  // ls-remote, the delivery row and the job; the worker checks again before it clones.
  const lock = checkDemoRepo(rawRepoUrl);
  if (!lock.ok) {
    console.warn(`[deliver] ${m.id}: refused a code delivery (${lock.reason})`);
    await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.deliveryRefused, milestoneId: m.id, contractId: c.id, detail: { source: "manual", repoUrl: rawRepoUrl.slice(0, 500), reason: lock.reason } });
    return jsonError(lock.reason, 403, { reason: lock.code });
  }
  // Local repositories (file://, absolute paths) only where localReposAllowed says so; see resolve.ts.
  const checked = checkRepoUrl(rawRepoUrl);
  if (!checked.ok) return jsonError(checked.reason, 400);
  const repoUrl = checked.url;
  const ref = typeof body?.ref === "string" && body.ref.trim() ? body.ref.trim() : "HEAD";
  if (!validRef(ref)) return jsonError("ref must be a branch, tag, HEAD or a 40-character commit id", 400);

  // DEMO_MODE: a branch or tag tip only. A pull request's head (refs/pull/N/head) or a fork's commit id is served by the
  // demo repository too, but it is a stranger's code.
  const resolved = await resolveRef(repoUrl, ref, { tipsOnly: demoModeOn() });
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
