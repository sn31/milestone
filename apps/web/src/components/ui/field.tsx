import type { ReactNode } from "react";
import { cx } from "./cx";

/** Classes for <input>, <textarea> and <select>: a sunken well with a strong hairline and the focus ring. */
export const inputClass =
  "w-full rounded-control border border-hairline-strong bg-surface-sunken px-3 py-2 text-[15px] text-fg placeholder:text-fg-faint " +
  "transition-colors duration-200 hover:border-fg-faint focus-visible:border-focus focus-visible:outline-none focus-visible:ring-0 " +
  "disabled:opacity-50";

export interface FieldProps {
  label: ReactNode;
  /** id of the control, for the label's htmlFor. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A form row: mono label, the control, then a hint or an error. */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cx("grid gap-2", className)}>
      <label htmlFor={htmlFor} className="type-label text-fg-faint">
        {label}
      </label>
      {children}
      {error ? <p className="text-[13px] text-state-danger">{error}</p> : hint ? <p className="text-[13px] text-fg-faint">{hint}</p> : null}
    </div>
  );
}
