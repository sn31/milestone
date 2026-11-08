import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second dev server (agents, QA) can run beside yours with NEXT_DIST_DIR=.next-<name>;
  // Next locks its build directory, so two servers cannot share .next.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@milestone/core", "@milestone/money", "@milestone/verify"],
  serverExternalPackages: ["pg", "pg-boss"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
