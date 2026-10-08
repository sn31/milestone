export function StatusBadge({ status }: { status: string }) {
  return <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">{status.replace("_", " ")}</span>;
}
