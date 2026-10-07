import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "offline", include: ["tests/{unit,contract,e2e}/**/*.test.ts"] } },
      { test: { name: "release", include: ["tests/release/**/*.test.ts"], testTimeout: 300_000 } },
    ],
  },
});
