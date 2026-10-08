"use server";

import { getDb } from "@/lib/db";
import { getActor, isContractFreelancer } from "@/lib/session";
import { redactDetail } from "./detail";

/**
 * One audit row's full detail, for the audit log's expanded row (the page ships only a summary). The row must belong
 * to the contract, and the draft redaction applies exactly as on the page. Null when there is no such row.
 */
export async function auditDetail(contractId: string, auditId: string): Promise<unknown> {
  const db = getDb();
  const [row, contract, actor] = await Promise.all([
    db.query.auditLog.findFirst({ columns: { event: true, detail: true }, where: (t, { and, eq }) => and(eq(t.id, auditId), eq(t.contractId, contractId)) }),
    db.query.contracts.findFirst({ columns: { freelancerId: true }, where: (t, { eq }) => eq(t.id, contractId) }),
    getActor(),
  ]);
  if (!row || !contract) return null;
  return redactDetail(row.event, row.detail ?? null, isContractFreelancer(actor, contract)) ?? null;
}
