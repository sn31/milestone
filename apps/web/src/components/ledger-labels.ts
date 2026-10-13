// How ledger ids read on screen: the ledger grid and a dispute's evidence pack both use these. Pure, client and server.

/** Owner ids the demo uses, by the role they name. */
const OWNER: Record<string, string> = { usr_client: "client", usr_freelancer: "freelancer", usr_partner: "partner", usr_platform: "platform" };

/**
 * An account as its family and the words after it: "held:mst_3" -> held, "mst_3"; "partner:usr_partner:receivable" ->
 * partner, "receivable"; "freelancer:usr_freelancer" -> freelancer, "". The owner id is dropped when it only repeats
 * the family (the full account stays in the tooltip).
 */
export function accountLabel(account: string): { family: string; rest: string } {
  const [family = account, ...parts] = account.split(":");
  const rest = parts.filter((p, i) => !(i === 0 && (OWNER[p] === family || p === family)));
  return { family, rest: rest.join(" · ") };
}

/** A ref as words: "release:mst_3:partner" -> "release · mst_3 · partner"; a PayPal id stays whole. */
export function refLabel(ref: string): string {
  return ref.includes(":") ? ref.split(":").filter(Boolean).join(" · ") : ref;
}

/**
 * A ref beside its milestone (the ledger grid, which has a Milestone column): the milestone id is dropped, since the row
 * already names it. "release:mst_3:partner" -> "release · partner", "release:mst_3" -> "release". An advance's ref is its
 * id alone ("adv_show_repaid"): the transaction chip already says "advance". Others as refLabel.
 */
export function refShort(ref: string): string {
  if (!ref.includes(":")) return ref;
  if (ref.startsWith("advance:")) return ref.slice("advance:".length);
  return ref
    .split(":")
    .filter((p) => p && !/^mst_/.test(p))
    .join(" · ");
}

export type TxnKind = "fund" | "release" | "repayment" | "refund" | "advance" | "fee" | "entry";

/**
 * What a transaction did, from its legs (txn ids are random in live data, so the id says nothing): the client into
 * escrow is a funding, escrow to the freelancer a release, escrow to the partner a repayment, escrow back to the client
 * a refund, the partner's cash into its receivable an advance.
 */
export function txnKind(legs: ReadonlyArray<{ account: string; direction: "debit" | "credit"; ref: string }>): TxnKind {
  const fam = (dir: "debit" | "credit") => new Set(legs.filter((l) => l.direction === dir).map((l) => l.account.split(":")[0]));
  const dr = fam("debit");
  const cr = fam("credit");
  if (dr.has("held")) {
    if (cr.has("freelancer")) return "release";
    if (cr.has("partner")) return "repayment";
    if (cr.has("client")) return "refund";
    if (cr.has("platform")) return "fee";
  }
  if (cr.has("held")) return "fund";
  if (legs.some((l) => l.ref.startsWith("advance:")) || (dr.has("partner") && cr.has("partner"))) return "advance";
  return "entry";
}
