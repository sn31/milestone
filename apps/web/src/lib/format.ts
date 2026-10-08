export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
export function formatDate(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "none";
}
