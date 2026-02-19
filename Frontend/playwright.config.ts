import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SITE_URL || "https://invest-six-nu.vercel.app";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "windows-chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    },
    {
      name: "macbook-webkit",
      use: {
        ...devices["Desktop Safari"]
      }
    },
    {
      name: "iphone-webkit",
      use: {
        ...devices["iPhone 13"]
      }
    }
  ]
});

