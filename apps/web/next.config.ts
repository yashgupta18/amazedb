import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: false,
  serverExternalPackages: ["pgsql-parser", "pg-cursor"],
  outputFileTracingIncludes: {
    "/api/control/[[...path]]": ["./node_modules/libpg-query/wasm/**/*"],
  },
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
