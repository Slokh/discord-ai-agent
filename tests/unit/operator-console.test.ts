import { afterEach, describe, expect, it, vi } from "vitest";
import { Script } from "node:vm";
import { loadConfig } from "../../src/config/env.js";
import type { OperatorDashboardRepository } from "../../src/db/operatorDashboardRepository.js";
import { startOperatorConsole } from "../../src/console/server.js";

describe("operator console", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves a private-by-deployment dashboard and read-only snapshot API", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer.host = "127.0.0.1";
    config.consoleServer.port = 0;
    const repository = {
      activityDetail: async ({ kind, id }: { kind: string; id: string; revision: string }) => kind === "conversation" && id === "runtime-example"
        ? {
          kind,
          id,
          active: false,
          generatedAt: new Date("2026-08-06T12:00:00.000Z"),
          revision: "revision-a",
          story: { id, kind, title: "Example prompt", lifecycle: [{ label: "Delivered", state: "complete" }], technicalEvents: [{ name: "agent.execution.completed" }] },
          messages: [{ id: "message-a", role: "member", content: "Hello" }],
        }
        : null,
      snapshot: async () => ({
        generatedAt: new Date("2026-08-06T12:00:00.000Z"),
        revision: "revision-a",
        services: [],
        summary: { healthyServices: 0, serviceCount: 4, serviceTelemetryAvailable: true, activeRuns: 0, activeTasks: 0, openImprovements: 0, needsAttention: 0 },
        executions: [], tasks: [], improvements: { counts: {}, cases: [] }, deployments: [], producers: [],
        activity: [{
          id: "runtime-example", kind: "runtime", title: "Example prompt", status: "succeeded",
          occurredAt: new Date("2026-08-06T11:59:00.000Z"), startedAt: new Date("2026-08-06T11:58:59.000Z"),
          deliveryState: "delivered", events: [{ id: "event-a", name: "agent.execution.completed", level: "info", createdAt: new Date("2026-08-06T11:59:00.000Z") }],
        }],
      }),
    } as unknown as OperatorDashboardRepository;
    const runtime = await startOperatorConsole({ config, repository });
    close = runtime.close;
    expect(runtime.server.keepAliveTimeout).toBe(75_000);
    expect(runtime.server.headersTimeout).toBe(80_000);
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("<h1>Console</h1>");
    expect(pageHtml).toContain("<title>Discord AI Agent · Console</title>");
    expect(pageHtml).toContain('id="environment"');
    expect(pageHtml).toContain('aria-label="System status"');
    expect(pageHtml).toContain('aria-describedby="services-tooltip"');
    expect(pageHtml).toContain('aria-describedby="producers-tooltip"');
    expect(pageHtml).toContain('class="topbar-system" aria-label="System status"');
    expect(pageHtml).not.toContain('id="improvements-panel"');
    expect(pageHtml).toContain('aria-controls="activity-panel"');
    expect(pageHtml).toContain('aria-label="Show blocked work"');
    expect(pageHtml).not.toContain('id="attention-panel"');
    expect(pageHtml).not.toContain("<h2>Needs attention</h2>");
    expect(pageHtml).toContain('<h2 id="activity-heading-title" tabindex="-1">Activity</h2>');
    expect(pageHtml).toContain('id="filter-all-count"');
    expect(pageHtml).toContain('id="filter-active-count"');
    expect(pageHtml).toContain('id="filter-waiting-count"');
    expect(pageHtml).toContain('id="filter-blocked-count"');
    expect(pageHtml).toContain('id="activity-detail-view"');
    expect(pageHtml).toContain('class="console-workspace"');
    expect(pageHtml).toContain('id="activity-scroll" class="activity-scroll"');
    expect(pageHtml).toContain("Select activity");
    expect(pageHtml).toContain('id="dashboard-loading" class="loading-shell overview-loading" role="status" aria-live="polite"');
    expect(pageHtml).toContain('id="dashboard-view" class="loading-target" aria-busy="true" inert');
    expect(pageHtml).toContain("Loading production data");
    expect(pageHtml).not.toContain("<h2>Active prompts</h2>");
    expect(pageHtml).not.toContain("<h2>Code changes</h2>");
    expect(pageHtml).not.toContain("<h2>Proof producers</h2>");
    expect(pageHtml).not.toContain("Everything in motion.");
    expect(pageHtml).toContain('name="color-scheme" content="dark"');
    expect(pageHtml).not.toContain("/assets/reload.js");

    const stylesheet = await fetch(`${baseUrl}/assets/styles.css?v=1`);
    expect(stylesheet.headers.get("cache-control")).toBe("no-store");
    const stylesheetText = await stylesheet.text();
    expect(stylesheetText).toContain("color-scheme:dark");
    expect(stylesheetText).toContain("grid-template-columns:10px minmax(0,1fr) auto");
    expect(stylesheetText).toContain(".story-main{display:block;min-width:0}");
    expect(stylesheetText).toContain(".story-title-row .story-meta{flex:1;margin-top:0;overflow:hidden}");
    expect(stylesheetText).toContain(".story-detail-row{display:block;min-width:0");
    expect(stylesheetText).toContain(".story-detail-row .story-title{display:block;font-weight:400}");
    expect(stylesheetText).toContain(".status-segment:hover .status-tooltip");
    expect(stylesheetText).toContain(".timeline{display:block");
    expect(stylesheetText).toContain(".console-workspace{display:grid;grid-template-columns:minmax(340px,400px) minmax(0,1fr)");
    expect(stylesheetText).toContain(".shell{width:100%;margin:0;padding:0}");
    expect(stylesheetText).toContain("gap:0;height:calc(100vh - 68px)");
    expect(stylesheetText).toContain(".activity-panel{display:flex;min-width:0;min-height:0;flex-direction:column;padding:0;overflow:hidden;border-width:0 1px 0 0;border-radius:0");
    expect(stylesheetText).toContain(".activity-scroll{flex:1;min-height:0");
    expect(stylesheetText).toContain(".activity-scroll{flex:1;min-height:0;padding:0 0 16px");
    expect(stylesheetText).toContain(".activity-panel .story-summary{gap:9px;padding:12px 15px}");
    expect(stylesheetText).toContain(".story.selected{");
    expect(stylesheetText).toContain(".detail-selected .activity-panel{display:none}");
    expect(stylesheetText).not.toContain(".improvement-list");
    expect(stylesheetText).not.toContain(".improvement-filter");
    expect(stylesheetText).not.toContain(".attention-panel");
    expect(stylesheetText).toContain(".activity-filters{display:flex;align-items:stretch;justify-content:space-between;gap:8px;width:100%;overflow-x:auto");
    expect(stylesheetText).toContain("border-bottom:1px solid var(--line);border-radius:0;background:transparent");
    expect(stylesheetText).toContain('.activity-filters button[aria-pressed="true"]');
    expect(stylesheetText).toContain(".detail-event");
    expect(stylesheetText).toContain(".story-latency.very_slow");
    expect(stylesheetText).toContain(".detail-run-list");
    expect(stylesheetText).toContain(".loading-target.is-ready");
    expect(stylesheetText).toContain(".console-content{display:flow-root");
    expect(stylesheetText).toContain("@keyframes skeleton-shimmer");
    expect(stylesheetText).toContain("animation:none!important");
    expect(stylesheetText).toContain("grid-template-rows:12px auto");
    expect(stylesheetText).not.toMatch(/font(?:-size)?:10px/);
    expect(stylesheetText).not.toContain("font-size:9px");
    expect(stylesheetText).toContain("@media(prefers-reduced-motion:reduce)");

    const clientScript = await fetch(`${baseUrl}/assets/app.js?v=1`).then((response) => response.text());
    expect(() => new Script(clientScript)).not.toThrow();
    expect(clientScript).toContain('aria-hidden="true"');
    expect(clientScript).toContain('datetime="');
    expect(clientScript).toContain('activityFilter=["all","active","waiting","blocked","failures","system"]');
    expect(clientScript).toContain("renderActivityDetail");
    expect(clientScript).toContain("refreshActivityDetail");
    expect(clientScript).toContain("history.pushState");
    expect(clientScript).toContain('window.addEventListener("popstate"');
    expect(clientScript).toContain('target.closest("a.story")');
    expect(clientScript).toContain('aria-current="true"');
    expect(clientScript).toContain("<h2>Context</h2>");
    expect(clientScript).toContain("visibleContextMessages");
    expect(clientScript).toContain("message.directParent");
    expect(clientScript).toContain("context-toggle");
    expect(clientScript).toContain("aria-expanded");
    expect(clientScript).toContain('class="context-history-toggle"');
    expect(clientScript).not.toContain("context-history-control");
    expect(clientScript).toContain("message-time-link");
    expect(clientScript).not.toContain('safeLink(message.url,"Open ↗")');
    expect(clientScript).toContain("activityPath");
    expect(clientScript).not.toContain("disclosureState");
    expect(clientScript).toContain("restoreViewAnchor");
    expect(clientScript).toContain("storyMeta");
    expect(clientScript).toContain('class="story-detail-row"><span class="story-title"');
    expect(clientScript).toContain('hasParent?"reply":"prompt"');
    expect(clientScript).not.toContain('class="story-parent"');
    expect(clientScript).toContain("story.hasParent");
    expect(clientScript).not.toContain("improvementAttentionOnly");
    expect(clientScript).toContain('item.workState===selected');
    expect(clientScript).toContain('setActivityFilter("blocked",true)');
    expect(clientScript).toContain('"Reply delivered","Code change completed"');
    expect(clientScript).toContain('<span class="sr-only">Duration </span>');
    expect(clientScript).toContain("story.attempts>1");
    expect(clientScript).toContain("discord\\.com\\/channels");
    expect(clientScript).toContain('typeof filter==="string"');
    expect(clientScript).toContain("if(refreshInFlight)return refreshInFlight");
    expect(clientScript).toContain('renderChanged("activity"');
    expect(clientScript).toContain('revealView("dashboard-view","dashboard-loading")');
    expect(clientScript).toContain('removeAttribute("inert")');
    expect(clientScript).toContain('setAttribute("aria-busy","false")');
    expect(clientScript).not.toContain("setInterval(()=>");

    const snapshot = await fetch(`${baseUrl}/api/snapshot`);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    await expect(snapshot.json()).resolves.toMatchObject({
      schemaVersion: 2,
      environment: "test",
      revision: "revision-a",
      summary: { serviceCount: 4, activeActivity: 0 },
      activity: { active: [], recent: [expect.objectContaining({ id: "runtime-example" })] },
    });
    const snapshotPayload = await fetch(`${baseUrl}/api/snapshot`).then((response) => response.json()) as { activity: { recent: Array<Record<string, unknown>> } };
    expect(snapshotPayload.activity.recent[0]).not.toHaveProperty("technicalEvents");
    expect(snapshotPayload.activity.recent[0]).not.toHaveProperty("lifecycle");
    expect(snapshotPayload.activity.recent[0]).not.toHaveProperty("runs");

    const mutation = await fetch(`${baseUrl}/api/snapshot`, { method: "POST" });
    expect(mutation.status).toBe(405);

    const conversation = await fetch(`${baseUrl}/api/activity/conversation/runtime-example`);
    expect(conversation.status).toBe(200);
    await expect(conversation.json()).resolves.toMatchObject({
      schemaVersion: 1,
      kind: "conversation",
      story: { id: "runtime-example", technicalEvents: [{ name: "agent.execution.completed" }] },
      messages: [{ id: "message-a", content: "Hello" }],
    });
    expect((await fetch(`${baseUrl}/api/activity/conversation/missing`)).status).toBe(404);

    const detailPage = await fetch(`${baseUrl}/activity/conversation/runtime-example`);
    expect(detailPage.status).toBe(200);
    const detailHtml = await detailPage.text();
    expect(detailHtml).toContain('id="activity-detail"');
    expect(detailHtml).toContain('id="dashboard-loading" class="loading-shell overview-loading" role="status" aria-live="polite"');
    expect(detailHtml).not.toContain('id="detail-page-loading"');
    expect(detailHtml).toContain('id="dashboard-view" class="loading-target" aria-busy="true" inert');
    expect(detailHtml).toContain('id="activity-detail-view" class="activity-detail-view workspace-detail"');

    expect((await fetch(`${baseUrl}/activity/conversation/runtime-example/extra`)).status).toBe(404);
  });

  it("enables same-origin browser reload only for a development server", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    const repository = {
      activityDetail: async () => null,
      snapshot: async () => ({}),
    } as unknown as OperatorDashboardRepository;
    const runtime = await startOperatorConsole({ config, repository, liveReload: true });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const pageHtml = await fetch(baseUrl).then((response) => response.text());
    const reloadClient = await fetch(`${baseUrl}/assets/reload.js`).then((response) => response.text());

    expect(pageHtml).toContain('<script src="/assets/reload.js?v=1" defer></script>');
    expect(reloadClient).toContain('new EventSource("/__dev/reload")');
    expect(reloadClient).toContain("window.location.reload()");
  });

  it("coalesces only overlapping snapshot reads", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    let releaseFirst: (() => void) | undefined;
    const snapshot = vi.fn(async () => {
      if (snapshot.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return {
        generatedAt: new Date("2026-08-06T12:00:00.000Z"),
        services: [], summary: {}, executions: [], tasks: [],
        improvements: { counts: {}, cases: [] }, deployments: [], producers: [], activity: [],
      };
    });
    const runtime = await startOperatorConsole({
      config,
      repository: { snapshot, activityDetail: async () => null },
    });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    const url = `http://127.0.0.1:${address.port}/api/snapshot`;

    const first = fetch(url);
    const second = fetch(url);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    releaseFirst?.();
    await Promise.all([first, second]);
    await fetch(url);

    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
