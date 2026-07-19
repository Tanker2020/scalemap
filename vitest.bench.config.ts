/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated config for `npm run bench`. The main vite.config.ts EXCLUDES bench/** from the default
// `npx vitest run` (a wall-clock timing assertion is meaningless under the parallel suite's core
// contention — see bench/enginePerf.bench.test.ts's header). This config runs ONLY the bench, in
// its own process with nothing competing for cores, which is the environment its timing assumes.
export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["bench/**/*.test.ts"],
  },
});
