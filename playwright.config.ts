import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
  webServer: {
    command: "npx vite --config vite.console.config.ts --mode e2e --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174/console/",
    reuseExistingServer: true,
  },
});
