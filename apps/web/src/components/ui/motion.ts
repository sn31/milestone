// Motion tokens for JS animations. Mirrors --ease-* and --dur-* in globals.css; see DESIGN.md section 1.5.

type Bezier = [number, number, number, number];

export const EASE: { glide: Bezier; shift: Bezier } = {
  /** Arrivals: reveals, count-ups, stamps. */
  glide: [0.16, 1, 0.3, 1],
  /** Movement between two places: money in transit, segment changes. */
  shift: [0.65, 0, 0.35, 1],
};

/** Durations in seconds (motion's unit). */
export const DUR = { press: 0.12, quick: 0.2, reveal: 0.48, count: 0.9, transit: 1.4 } as const;

/** Stagger between list items, capped at 8 items so long lists do not crawl. */
export function staggerDelay(i: number, step = 0.05): number {
  return Math.min(i, 8) * step;
}

/** Props for a motion element that rises into place: `<motion.div {...revealProps(i)} />`. */
export function revealProps(i = 0) {
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DUR.reveal, ease: EASE.glide, delay: staggerDelay(i) },
  };
}

/** True when the user asked for reduced motion. Client only; false on the server. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
