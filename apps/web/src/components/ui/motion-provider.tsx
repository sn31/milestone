"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { DUR, EASE } from "./motion";

/** Wraps the app once (in the root layout): motion honours prefers-reduced-motion and defaults to the glide ease. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: DUR.reveal, ease: EASE.glide }}>
      {children}
    </MotionConfig>
  );
}
