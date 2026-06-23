import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Engine modules under src/lib are pure, framework-free TypeScript,
    // so the default node environment is all we need.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Integration tests need a live DB and run via vitest.integration.config.ts
    // (npm run test:db). Keep the default `npm run test` fast and DB-free.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
