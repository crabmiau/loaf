import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/compaction/**/*.test.ts",
      "src/core/**/*.test.ts",
      "src/rpc/**/*.test.ts",
      "src/skills/**/*.test.ts",
      "src/tools/**/*.test.ts",
      "src/interleaving.test.ts",
      "src/openai.interleaving.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/skills/loader.ts", "src/skills/matcher.ts", "src/skills/prompt.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
