/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vitest: seed Math.random before every test for deterministic, order-independent runs.
  // See vitest.setup.ts for why (process-global RNG bleeding across worker-scheduled test files).
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The engine perf bench is a wall-clock timing assertion, which is meaningless when run beside
    // ~117 other files across parallel workers competing for cores (it read ~11ms median in-suite
    // for a step that costs ~3.9ms alone, failing on every run). It is excluded here and run in
    // isolation via `npm run bench`, which points vitest at the bench/ dir directly. See the
    // file header in bench/enginePerf.bench.test.ts for the full measurement rationale.
    // Wave 3 final review (Minor #9): a stray, pre-existing nested git worktree at
    // .claude/worktrees/ carries its own duplicate react/react-dom install -- picking it up under
    // a bare `npx vitest run` produces ~57 failed files / ~466 failed tests that are not real
    // failures in THIS repo. Excluded so the bare command matches what every task in this repo
    // actually needs to run.
    exclude: [...configDefaults.exclude, "bench/**", ".claude/**"],
  },

  // Phase 5 (D1): the globe view's three.js dependency (~600KB) gets its own chunk so it
  // doesn't inflate the initial bundle for users who never open the globe.
  build: {
    rollupOptions: {
      output: {
        manualChunks: { three: ["three"] },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
