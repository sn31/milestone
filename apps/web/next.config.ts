import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@milestone/core", "@milestone/money"],
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
