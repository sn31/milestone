import { StatePill } from "@/components/ui";

/** Status badge for a contract or milestone status. Kept for existing imports; new code uses StatePill from @/components/ui. */
export function StatusPill({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  return <StatePill state={status} size={size} />;
}
