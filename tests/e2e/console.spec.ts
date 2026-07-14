import { expect, test, type Page } from "@playwright/test";
import { fixtureArtifact, fixtureRuns, fixtureSnapshots } from "../../src/control/console/fixtures.js";

async function mockConsoleApi(page: Page, options: { failStream?: boolean; mutateAfterPoll?: boolean } = {}) {
  let snapshotPolls = 0;
  await page.route("**/api/runs?**", (route) => route.fulfill({ json: { runs: fixtureRuns, generatedAt: new Date().toISOString() } }));
  await page.route("**/api/runs/*/feedback", (route) => route.fulfill({ json: { feedback: null } }));
  await page.route("**/api/runs/*/artifacts/*", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    route.fulfill({ body: fixtureArtifact(parts.at(-3) ?? "", parts.at(-1) ?? ""), contentType: "text/plain" });
  });
  await page.route("**/api/runs/*/stream", (route) => options.failStream
    ? route.abort("failed")
    : route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: heartbeat\ndata: {}\n\n" }));
  await page.route("**/api/runs/*", (route) => {
    snapshotPolls += 1;
    const runId = new URL(route.request().url()).pathname.split("/").at(-1);
    const original = fixtureSnapshots.find((snapshot) => snapshot.run.runId === runId) ?? fixtureSnapshots[0];
    const snapshot = options.mutateAfterPoll && snapshotPolls > 1
      ? { ...original, diagnostics: [...original.diagnostics, "Polling fallback recovered the latest run version."] }
      : original;
    return route.fulfill({ json: snapshot });
  });
}

test.beforeEach(async ({ page }) => { await mockConsoleApi(page); });

test("debugs model rounds, prompt composition, artifacts, and critical-path latency", async ({ page }) => {
  await page.goto("/console/");
  await page.getByText("Discord mention from UserB", { exact: true }).click();
  await page.getByRole("tab", { name: "Debugger" }).click();
  await expect(page.getByRole("heading", { name: "Prompt debugger" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Critical path" })).toBeVisible();
  await expect(page.getByText("Tool Selection", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty Response Recovery", { exact: true })).toBeVisible();
  await expect(page.getByText("Revision", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Base System Prompt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load prompt" }).first().click();
  await expect(page.getByText("over the past 3 months who is the best at little phone games", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load response" }).first().click();
  await expect(page.getByText("Tool calls (1)")).toBeVisible();
});

test("renders timeline, artifacts, and full artifact content", async ({ page }) => {
  await page.goto("/console/");
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.getByRole("button", { name: /Codex prompt/ }).click();
  await expect(page.getByText(/Fixture artifact artifact-prompt/)).toBeVisible();
});

test("compares runs and captures feedback", async ({ page }) => {
  await page.goto("/console/");
  await page.getByRole("tab", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { name: "Compare runs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Performance deltas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model calls by purpose" })).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("region", { name: "Run feedback" })).toBeVisible();
});

test("falls back to polling after stream failure", async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  await mockConsoleApi(page, { failStream: true, mutateAfterPoll: true });
  await page.goto("/console/");
  await expect(page.getByText("Polling fallback recovered the latest run version.")).toBeVisible({ timeout: 12_000 });
});

test("remains usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/console/");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
