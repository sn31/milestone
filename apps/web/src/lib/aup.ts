/**
 * The web app's side of the PayPal Acceptable Use Policy check (rule in @milestone/core aup.ts, check in
 * @milestone/verify aup/). ensureAup starts a check when the contract text has none; aupView is what the contract page,
 * /ops and the MCP tools show.
 */
import { AUP_LABEL, AUP_REFUSAL_TEXT, aupGate, enqueue, ensureAupCheck, type AupDeps, type AupFlag, type AupStatus, type Executor, type contracts } from "@milestone/core";
import { aupCategory, aupKeywordFlags, isModelConfigured, PAYPAL_AUP_SOURCE } from "@milestone/verify";

export const aupDeps: AupDeps = {
  keywords: aupKeywordFlags,
  modelConfigured: () => isModelConfigured(),
  enqueue: (contractId, hash) => enqueue("aup", contractId, { contractId, textHash: hash }, { dedupe: `aup:${hash}` }),
  policy: { ...PAYPAL_AUP_SOURCE },
};

/**
 * Starts a check when the contract's current text has none (see ensureAupCheck). A queue failure is logged and leaves
 * the contract unchecked, so the next signature or funding attempt tries again; it never fails the caller's request.
 */
export async function ensureAup(db: Executor, contractId: string, actor = "system"): Promise<void> {
  try {
    await ensureAupCheck(db, contractId, aupDeps, actor);
  } catch (e) {
    console.error(`aup check for ${contractId} could not start:`, e instanceof Error ? e.message : e);
  }
}

type ContractRow = typeof contracts.$inferSelect;

export interface AupView {
  status: AupStatus | "unchecked";
  label: string;
  /** clear: may be signed and funded. checking: wait. review: an operator must clear it. rejected: final. */
  tone: "clear" | "keywords" | "checking" | "review" | "rejected" | "unchecked";
  allowsSigningAndFunding: boolean;
  /** Why signing and funding are refused, in words; null when they are allowed. */
  refusal: string | null;
  mode: string | null;
  model: string | null;
  recorded: boolean;
  checkedAt: string | null;
  error: string | null;
  policy: { url: string; retrievedOn: string };
  flags: Array<AupFlag & { name: string }>;
  resolution: { action: "clear" | "reject"; by: string; at: string; note: string } | null;
}

/** The contract's AUP check as the page, /ops and the MCP tools show it. */
export function aupView(c: Pick<ContractRow, "aupStatus" | "aupCheck" | "aupCheckedAt">): AupView {
  const status = (c.aupStatus ?? "unchecked") as AupView["status"];
  const gate = aupGate(c);
  const check = c.aupCheck ?? null;
  const tone: AupView["tone"] =
    status === "clear" || status === "cleared" ? "clear" : status === "keywords_only" ? "keywords" : status === "checking" ? "checking" : status === "rejected" ? "rejected" : status === "review" ? "review" : "unchecked";
  return {
    status,
    label: AUP_LABEL[status] ?? status,
    tone,
    allowsSigningAndFunding: "ok" in gate,
    refusal: "refused" in gate ? AUP_REFUSAL_TEXT[gate.refused] : null,
    mode: check?.mode ?? null,
    model: check?.model ?? null,
    recorded: check?.mode === "recorded",
    checkedAt: c.aupCheckedAt?.toISOString() ?? null,
    error: check?.error ?? null,
    policy: check?.policy ?? { ...PAYPAL_AUP_SOURCE },
    // While checking, the stored flags are the keyword pass's so far; they are shown as such.
    flags: (check?.flags ?? []).map((f) => ({ ...f, name: aupCategory(f.category)?.name ?? f.category })),
    resolution: check?.resolution ?? null,
  };
}
