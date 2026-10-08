import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AUDIT_EVENTS, audit, contracts, criteria, fromPayPalValue, milestones, type ContractSpec } from "@milestone/core";
import { compileContract, isModelConfigured } from "@milestone/verify";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";

interface Compiled { contract: ContractSpec; advanceEligible: Record<number, boolean> }

function demoContract(totalMinor: number, currency: string): Compiled {
  const a = Math.floor(totalMinor / 3);
  const b = Math.floor(totalMinor / 3);
  const amounts = [a, b, totalMinor - a - b];
  const specs = [
    ["Project setup", "build", "Project builds", { command: "npm run build" }],
    ["Core features", "test", "Test suite passes", { command: "npm test" }],
    ["Docs and handoff", "file", "README exists", { path: "README.md" }],
  ] as const;
  const contract: ContractSpec = {
    title: "Demo contract",
    currency,
    totalMinor,
    milestones: specs.map(([title, kind, description, spec], i) => ({
      seq: i + 1,
      title,
      amountMinor: amounts[i],
      criteria: [{ id: `demo-${i + 1}`, kind, description, spec: { ...spec }, required: true }],
    })),
  };
  return { contract, advanceEligible: { 1: true, 2: true, 3: true } };
}

async function compile(scopeText: string, currency: string, totalMinor: number, repo?: string): Promise<Compiled> {
  if (!(await isModelConfigured())) return demoContract(totalMinor, currency);
  return compileContract({ scopeText, currency, totalMinor, repoHint: repo });
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A browser form post gets a redirect back to the form with the message; API callers get JSON. */
function fail(req: Request, error: string, status: number) {
  if ((req.headers.get("accept") ?? "").includes("text/html")) {
    const url = new URL("/contracts/new", req.url);
    url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  }
  return jsonError(error, status);
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return fail(req, "expected a form body", 400);
  const scope = String(form.get("scope") ?? "").trim();
  const title = String(form.get("title") ?? "").trim().slice(0, 120);
  const currency = String(form.get("currency") ?? "USD").trim().toUpperCase();
  const totalRaw = String(form.get("total") ?? "").trim();
  const totalMinor = /^\d+(\.\d{1,2})?$/.test(totalRaw) ? fromPayPalValue(totalRaw, currency) : NaN;
  const repo = String(form.get("repo") ?? "").trim() || undefined;
  if (!scope || !Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    return fail(req, "Scope, a positive total and a three-letter currency are required.", 400);
  }
  if (repo && !REPO.test(repo)) return fail(req, "Repository must look like owner/name.", 400);

  let result: Compiled;
  try {
    result = await compile(scope, currency, totalMinor, repo);
  } catch (e) {
    return fail(req, `Could not draft the contract: ${e instanceof Error ? e.message : "compile failed"}`, 502);
  }

  const actor = await getActor();
  const db = getDb();
  const contractId = `con_${randomUUID()}`;
  await db.transaction(async (tx) => {
    await tx.insert(contracts).values({
      id: contractId,
      clientId: "usr_client",
      freelancerId: "usr_freelancer",
      title: title || result.contract.title,
      scopeText: scope,
      currency,
      totalMinor,
      repoFullName: repo ?? null,
    });
    for (const m of result.contract.milestones) {
      const milestoneId = `mil_${randomUUID()}`;
      await tx.insert(milestones).values({
        id: milestoneId,
        contractId,
        seq: m.seq,
        title: m.title,
        amountMinor: m.amountMinor,
        dueAt: m.dueAt ? new Date(m.dueAt) : null,
        status: "draft",
        advanceEligible: result.advanceEligible[m.seq] ?? false,
      });
      if (m.criteria.length > 0) {
        await tx.insert(criteria).values(m.criteria.map((c) => ({
          id: `crt_${randomUUID()}`,
          milestoneId,
          kind: c.kind,
          description: c.description,
          spec: c.spec,
          required: c.required,
        })));
      }
    }
    await audit(tx, { actor: actor.userId, event: AUDIT_EVENTS.contractCreated, contractId, detail: { milestones: result.contract.milestones.length } });
  });
  return NextResponse.redirect(new URL(`/contracts/${contractId}`, req.url), 303);
}
