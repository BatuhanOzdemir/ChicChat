import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Integration tests that talk to the live local Supabase Postgres.
// Run with: npm run test:db  (requires `npm run db:start` + migrations applied).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests share one local DB (some run the seed) — run files serially
    // so they don't race on the same rows.
    fileParallelism: false,
  },
});
