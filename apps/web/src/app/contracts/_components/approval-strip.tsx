import { Button, cx, StateGlyph } from "@/components/ui";
import { formatDate } from "@/lib/format";

interface Party {
  role: string;
  name: string;
  at: Date | null;
}

function Signature({ role, name, at }: Party) {
  const signed = Boolean(at);
  return (
    <li data-tone={signed ? "funded" : "draft"} className="flex min-w-0 items-center gap-2.5 sm:shrink-0">
      <span className={cx("grid size-5 shrink-0 place-items-center rounded-chip text-tone", signed ? "bg-tone-soft" : "border border-dashed border-hairline-strong")}>
        <StateGlyph glyph={signed ? "check" : "ring"} className="size-[9px]" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-fg">{name}</span>
        <span className="block font-mono text-[10.5px] tracking-[0.06em] whitespace-nowrap text-fg-faint uppercase tabular">
          {role} · {signed ? `signed ${formatDate(at)}` : "not signed"}
        </span>
      </span>
    </li>
  );
}

/**
 * Both parties' approvals on one line. Funding opens only once both have signed; the acting party's approve button sits
 * at the right end while their signature is missing. Posts to the same approve route as before.
 */
export function ApprovalStrip({
  contractId,
  client,
  freelancer,
  canApproveAs,
  isParty,
  criteriaVersion,
  blocked,
}: {
  contractId: string;
  client: Party;
  freelancer: Party;
  /** The acting role when they are a party who has not signed yet. */
  canApproveAs: string | null;
  isParty: boolean;
  /** Fingerprint of the checks on screen; the approve route records nothing if they changed since (criteriaVersion in core). */
  criteriaVersion?: string;
  /** Set while the PayPal AUP check does not allow signing: why, in place of the approve button. */
  blocked?: string | null;
}) {
  const both = Boolean(client.at && freelancer.at);
  return (
    <section aria-label="Approvals" data-tone={both ? "funded" : "draft"} className="rounded-panel border border-hairline bg-surface-sunken">
      <div className="flex flex-col gap-4 px-4 py-3.5 sm:px-5 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <p className="type-label shrink-0 text-fg-faint">Signatures</p>
          <ol className="grid min-w-0 gap-3 sm:flex sm:items-center sm:gap-6">
            <Signature {...client} />
            <Signature {...freelancer} />
          </ol>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:justify-end">
          {both ? (
            <p className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-tone uppercase">
              <span aria-hidden className="size-1.5 rounded-full bg-tone" />
              Funding open
            </p>
          ) : canApproveAs && blocked ? (
            <p className="text-[13px] text-fg-muted">{blocked}</p>
          ) : canApproveAs ? (
            <>
              <p className="text-[13px] text-fg-muted">Approving accepts the milestones and their checks.</p>
              <form action={`/api/contracts/${contractId}/approve`} method="post">
                {criteriaVersion ? <input type="hidden" name="criteriaVersion" value={criteriaVersion} /> : null}
                <Button type="submit" variant="primary" size="sm">
                  Approve as {canApproveAs}
                </Button>
              </form>
            </>
          ) : (
            <p className="text-[13px] text-fg-muted">
              {isParty ? "You have signed. Switch role to sign as the other party." : "Funding opens once both parties sign."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
