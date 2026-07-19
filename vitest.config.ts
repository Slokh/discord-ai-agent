import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      thresholds: {
        statements: 60,
        branches: 48,
        functions: 60,
        lines: 60,
      },
    },
  }
});
