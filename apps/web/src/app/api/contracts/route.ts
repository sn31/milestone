import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auditLog, contracts, criteria, milestones, type ContractSpec } from "@milestone/core";
import { compileContract } from "@milestone/verify";
import { getDb } from "@/lib/db";
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
  if (!process.env.ANTHROPIC_API_KEY) return demoContract(totalMinor, currency);
  return compileContract({ scopeText, currency, totalMinor, repoHint: repo });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const scope = String(form.get("scope") ?? "").trim();
  const currency = String(form.get("currency") ?? "USD").trim().toUpperCase();
  const totalMinor = Math.round(Number(form.get("total")) * 100);
  const repo = String(form.get("repo") ?? "").trim() || undefined;
  if (!scope || !Number.isInteger(totalMinor) || totalMinor <= 0 || !currency) {
    return NextResponse.json({ error: "scope, a positive total and currency are required" }, { status: 400 });
  }

  let result: Compiled;
  try {
    result = await compile(scope, currency, totalMinor, repo);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "compile failed" }, { status: 502 });
  }

  const actor = await getActor();
  const db = getDb();
  const contractId = `con_${randomUUID()}`;
  await db.transaction(async (tx) => {
    await tx.insert(contracts).values({
      id: contractId,
      clientId: "usr_client",
      freelancerId: "usr_freelancer",
      title: result.contract.title,
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
      await tx.insert(criteria).values(m.criteria.map((c) => ({
        id: `crt_${randomUUID()}`,
        milestoneId,
        kind: c.kind,
        description: c.description,
        spec: c.spec,
        required: c.required,
      })));
    }
    await tx.insert(auditLog).values({ id: randomUUID(), contractId, actor: actor.userId, event: "contract.created", detail: { milestones: result.contract.milestones.length } });
  });
  return NextResponse.redirect(new URL(`/contracts/${contractId}`, req.url), 303);
}
