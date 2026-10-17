import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    // `tests/` holds the behavioural suites; `src/style-contract.test.ts` sits
    // next to the code it guards (matching obsidian-sonar's layout) because it
    // reads ../styles.css resolved relative to its own location.
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-window.ts", "tests/setup-sdk-loader.ts"],
    // The core modules under test are pure and must NOT import `obsidian` at
    // runtime. This alias is a safety net: if a transitive import ever sneaks
    // one in, tests resolve to a tiny stub instead of failing to load.
    alias: {
      obsidian: resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
});
