/** Narrowing helpers for untyped JSON (jsonb columns, webhook bodies, job data). Pure. */

/** A plain object as a record; anything else (null, arrays, scalars) as {}. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A non-empty string, else null. */
export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A finite number, else null. */
export function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An integer (at least `min` when given), else null. asInt(v, 0) reads a minor-unit amount. */
export function asInt(v: unknown, min?: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && (min === undefined || v >= min) ? v : null;
}
