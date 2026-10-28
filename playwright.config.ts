import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  webServer: process.env.CI
    ? [
        {
          command: "pnpm --filter @autoblogger/api start",
          url: "http://127.0.0.1:4000/api/health",
          env: { AUTO_SUMMARIES: "false" },
          timeout: 60000,
        },
        {
          command: "pnpm --filter @autoblogger/web start",
          url: "http://127.0.0.1:3000",
          timeout: 60000,
        },
      ]
    : undefined,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: [["list"], ["html", { open: "never" }]],
});
