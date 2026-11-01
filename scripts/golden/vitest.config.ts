/**
 * Golden-file exporter for the Python port (docs/PORT.md §5).
 *
 * Runs the TypeScript domain functions over recorded inputs and writes their
 * exact outputs to python/tests/golden/*.json. The Python tests must reproduce
 * every output. Run: npx vitest run --config scripts/golden/vitest.config.ts
 */
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["scripts/golden/**/*.golden.ts"],
  },
});
