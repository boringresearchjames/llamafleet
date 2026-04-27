import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Run test files sequentially so each file gets its own fresh server
    fileParallelism: false,
  },
});
