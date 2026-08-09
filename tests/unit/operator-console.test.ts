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
    config.nodeEnv = "test";
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
          story: { id, kind, title: "Example prompt", technicalEvents: [{ name: "agent.execution.completed" }] },
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
    expect(pageHtml).not.toContain('id="attention-segment"');
    expect(pageHtml).not.toContain('id="freshness"');
    expect(pageHtml).not.toContain('id="system-label"');
    expect(pageHtml).not.toContain('id="attention-panel"');
    expect(pageHtml).not.toContain("<h2>Needs attention</h2>");
    expect(pageHtml).toContain('id="activity-panel" class="panel activity-panel" aria-label="Activity"');
    expect(pageHtml).not.toContain('id="activity-heading-title"');
    expect(pageHtml).toContain('id="filter-all-count"');
    expect(pageHtml).toContain('id="filter-running-count"');
    expect(pageHtml).toContain('id="filter-waiting-count"');
    expect(pageHtml).toContain('id="filter-issues-count"');
    expect(pageHtml).not.toContain('id="filter-blocked-count"');
    expect(pageHtml).not.toContain('id="filter-failed-count"');
    expect(pageHtml).toContain('id="filter-done-count"');
    expect(pageHtml).toContain('id="activity-type-trigger" type="button" aria-haspopup="listbox"');
    expect(pageHtml).toContain('id="activity-type-options" class="activity-type-options" role="listbox" aria-multiselectable="true" aria-label="Filter activity by type" hidden');
    expect(pageHtml).toContain('id="activity-type-label">Relevant</span>');
    expect(pageHtml).not.toContain('data-activity-type="all"');
    expect(pageHtml).toContain('data-activity-type="conversation" aria-selected="true"');
    expect(pageHtml).toContain('data-activity-type="improvement" aria-selected="true"');
    expect(pageHtml).toContain('data-activity-type="code_change" aria-selected="true"');
    expect(pageHtml).toContain("Prompts &amp; replies");
    expect(pageHtml).toContain("Messages");
    expect(pageHtml).not.toContain('id="activity-search-trigger"');
    expect(pageHtml).not.toContain('class="command-trigger"');
    expect(pageHtml).toContain('id="activity-search" class="activity-search" aria-labelledby="activity-search-title"');
    expect(pageHtml).toContain('role="combobox" aria-autocomplete="list"');
    expect(pageHtml).toContain('id="activity-search-results" class="activity-search-results" role="listbox"');
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
    expect(stylesheetText).toContain(".story-detail-row{display:flex;align-items:baseline;gap:8px;min-width:0");
    expect(stylesheetText).toContain(".story-detail-row .story-title{display:block;font-weight:400}");
    expect(stylesheetText).toContain(".story-author{flex:none;max-width:110px");
    expect(stylesheetText).toContain(".status-segment:hover .status-tooltip");
    expect(stylesheetText).toContain(".timeline{display:block");
    expect(stylesheetText).toContain(".console-workspace{display:grid;grid-template-columns:minmax(340px,400px) minmax(0,1fr)");
    expect(stylesheetText).toContain(".shell{width:100%;margin:0;padding:0}");
    expect(stylesheetText).toContain("grid-template-columns:auto minmax(0,1fr)");
    expect(stylesheetText).toContain(".topbar-system{display:flex;align-items:center;justify-content:flex-end");
    expect(stylesheetText).not.toContain(".freshness");
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
    expect(stylesheetText).not.toContain(".tooltip-alert");
    expect(stylesheetText).not.toContain(".activity-heading");
    expect(stylesheetText).toContain(".activity-filters{display:flex;align-items:stretch;gap:0;width:100%;overflow-x:auto");
    expect(stylesheetText).toContain(".activity-filter-controls{flex:none;border-bottom:1px solid var(--line)}");
    expect(stylesheetText).toContain(".activity-type-filter{position:relative;display:flex;align-items:center;justify-content:space-between;width:100%");
    expect(stylesheetText).toContain(".activity-type-options button:hover,.activity-type-options button:focus-visible{");
    expect(stylesheetText).toContain('.activity-type-options button[aria-selected="true"]');
    expect(stylesheetText).toContain(".activity-type-filter:focus-within{");
    expect(stylesheetText).toContain(".activity-search::backdrop{");
    expect(stylesheetText).toContain('.activity-search-result[aria-selected="true"]');
    expect(stylesheetText).not.toContain(".command-trigger");
    expect(stylesheetText).toContain("border-bottom:1px solid transparent;border-radius:0;background:transparent");
    expect(stylesheetText).toContain(".activity-day:first-child{margin-top:0;padding-top:12px}");
    expect(stylesheetText).toContain('.story-status-indicator[data-state="waiting"]');
    expect(stylesheetText).toContain('.story-status-indicator[data-state="failed"]');
    expect(stylesheetText).toContain("@keyframes status-pulse");
    expect(stylesheetText).toContain('.activity-filters button[aria-pressed="true"]');
    expect(stylesheetText).not.toContain(".conversation-section");
    expect(stylesheetText).toContain(".story-latency.very_slow");
    expect(stylesheetText).not.toContain(".context-history-toggle");
    expect(stylesheetText).toContain(".activity-detail-view.is-switching.preserving-detail #activity-detail");
    expect(stylesheetText).toContain("@keyframes detail-progress");
    expect(stylesheetText).toContain(".loading-target.is-ready");
    expect(stylesheetText).toContain(".console-content{display:flow-root");
    expect(stylesheetText).toContain("@keyframes skeleton-shimmer");
    expect(stylesheetText).toContain("animation:none!important");
    expect(stylesheetText).toContain("grid-template-columns:94px 7px 72px minmax(0,1fr) 48px");
    expect(stylesheetText).not.toMatch(/font(?:-size)?:10px/);
    expect(stylesheetText).not.toContain("font-size:9px");
    expect(stylesheetText).toContain("@media(prefers-reduced-motion:reduce)");

    const clientScript = await fetch(`${baseUrl}/assets/app.js?v=1`).then((response) => response.text());
    expect(() => new Script(clientScript)).not.toThrow();
    expect(clientScript).toContain('aria-hidden="true"');
    expect(clientScript).toContain('datetime="');
    expect(clientScript).toContain('activityFilter=["all","running","waiting","issues","done"]');
    expect(clientScript).toContain('filter==="issues"?["blocked","failed"].includes(lifecycle)');
    expect(clientScript).toContain('defaultActivityTypes=["conversation","improvement","code_change"]');
    expect(clientScript).toContain('let activityTypes=new Set');
    expect(clientScript).toContain('isDefaultActivityTypes()?"Relevant"');
    expect(clientScript).toContain("renderActivityDetail");
    expect(clientScript).toContain("detailLoadingShell");
    expect(clientScript).toContain('view.classList.add("is-switching")');
    expect(clientScript).toContain('view.classList.toggle("preserving-detail",preserve)');
    expect(clientScript).toContain('view.scrollTo({top:0})');
    expect(clientScript).toContain("refreshActivityDetail");
    expect(clientScript).toContain("initialSelectionHandled=Boolean(activityRoute())");
    expect(clientScript).toContain("selectInitialActivity(data)");
    expect(clientScript).toContain('history.replaceState(null,"",activityPath(story))');
    expect(clientScript).toContain("activityRoute()||mobileWorkspace()");
    expect(clientScript).toContain("history.pushState");
    expect(clientScript).toContain("openActivitySearch");
    expect(clientScript).toContain("renderActivitySearch");
    expect(clientScript).toContain("searchResultCard");
    expect(clientScript).toContain("storyMeta(story,active)");
    expect(clientScript).toContain("dialog.showModal()");
    expect(clientScript).toContain('(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"');
    expect(clientScript).toContain('event.key==="ArrowDown"||event.key==="ArrowUp"');
    expect(clientScript).toContain('event.key.toLowerCase()==="j"||event.key.toLowerCase()==="k"');
    expect(clientScript).toContain('if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();moveThroughActivity(event.key==="ArrowDown"?1:-1,true)');
    expect(clientScript).toContain('event.metaKey||event.ctrlKey||event.altKey||event.shiftKey');
    expect(clientScript).toContain('input.setAttribute("aria-activedescendant"');
    expect(clientScript).toContain("moveThroughActivity");
    expect(clientScript).toContain('window.addEventListener("popstate"');
    expect(clientScript).toContain('target.closest("a.story")');
    expect(clientScript).toContain('aria-current="true"');
    expect(clientScript).not.toContain("<h2>Context</h2>");
    expect(clientScript).toContain("const detailTrace=");
    expect(clientScript).toContain("const improvementTraceItems=");
    expect(clientScript).toContain('type:"trigger"');
    expect(clientScript).toContain('type:"evidence"');
    expect(clientScript).toContain('type:"contract"');
    expect(clientScript).toContain('type:"proof"');
    expect(clientScript).toContain("items.push(...improvementTraceItems(detail))");
    expect(clientScript).not.toContain('id="improvement-story-title"');
    expect(clientScript).toContain("message.directParent");
    expect(clientScript).toContain("trace-toggle");
    expect(clientScript).toContain("aria-expanded");
    expect(clientScript).not.toContain('class="context-history-toggle"');
    expect(clientScript).toContain("trace-time-link");
    expect(clientScript).not.toContain('safeLink(message.url,"Open ↗")');
    expect(clientScript).toContain("activityPath");
    expect(clientScript).not.toContain("disclosureState");
    expect(clientScript).toContain("restoreViewAnchor");
    expect(clientScript).toContain("storyMeta");
    expect(clientScript).toContain("storyIndicator");
    expect(clientScript).toContain('class="story-mark story-status-indicator"');
    expect(clientScript).toContain('role="img" aria-label="Status: ');
    expect(clientScript).not.toContain("statusBadge");
    expect(clientScript).not.toContain('class="active-now"');
    expect(clientScript).toContain("class=\"story-detail-row\">'+storyTiming(story,active)");
    expect(clientScript).toContain('hasParent?"reply":"prompt"');
    expect(clientScript).not.toContain('class="story-parent"');
    expect(clientScript).toContain("story.hasParent");
    expect(clientScript).not.toContain("improvementAttentionOnly");
    expect(clientScript).toContain("activityLifecycle");
    expect(clientScript).toContain("matchesActivityType");
    expect(clientScript).toContain('const lifecycle=activityLifecycle(item,active)');
    expect(clientScript).toContain('story.status==="delivery_pending"');
    expect(clientScript).toContain('story.workState==="terminal")return "done"');
    expect(clientScript).not.toContain('setActivityFilter("blocked",true)');
    expect(clientScript).not.toContain('el("attention-summary")');
    expect(clientScript).not.toContain('el("freshness")');
    expect(clientScript).toContain('const storyQualifier=');
    expect(clientScript).not.toContain('class="story-outcome"');
    expect(clientScript).not.toContain('class="story-branch');
    expect(clientScript).not.toContain('class="story-chevron"');
    expect(clientScript).toContain('<span class="sr-only">Duration </span>');
    expect(clientScript).toContain('Math.round(Number(value||0)/1000))+"s"');
    expect(clientScript).toContain("storyTiming(story,active)");
    expect(clientScript).toContain("storyAuthor(story)");
    expect(clientScript).toContain('<span class="sr-only">Author </span>');
    expect(clientScript).toContain('story.authorLabel||"Unknown author"');
    expect(clientScript).toContain("[story.title,story.authorLabel,story.summary");
    expect(clientScript).toContain("const detailMetrics=");
    expect(clientScript).toContain("const detailSpecialLinks=");
    expect(clientScript).toContain("const messageTraceItems=");
    expect(clientScript).toContain("discordText(item.summary,item.message.mentions,item.message.roles)");
    expect(clientScript).toContain('roles&&roles[id]?String(roles[id]):"role"');
    expect(clientScript).toContain('mentions&&mentions[id]?String(mentions[id]):"user"');
    expect(clientScript).toContain("const releaseTraceItems=");
    expect(clientScript).not.toContain("const messageDetail=");
    expect(clientScript).toContain("items.push(...messageTraceItems(detail))");
    expect(clientScript).toContain("items.push(...releaseTraceItems(detail))");
    expect(clientScript).toContain('story.kind==="message"?"Message":story.title');
    expect(clientScript).toContain('type:"check"');
    expect(clientScript).toContain('type:"embedding"');
    expect(clientScript).toContain('type:"release"');
    expect(clientScript).not.toContain('type:"batch"');
    expect(stylesheetText).toContain(".detail-hero .detail-metrics.metrics-5{grid-template-columns:repeat(5,minmax(0,1fr))}");
    expect(stylesheetText).toContain(".detail-hero .detail-metrics.metrics-6{grid-template-columns:repeat(6,minmax(0,1fr))}");
    expect(stylesheetText).toContain(".badge.embedded");
    expect(stylesheetText).toContain(".badge.not_embedded");
    expect(clientScript).not.toContain('detailMetric("Status"');
    expect(clientScript).toContain("const traceItems=");
    expect(clientScript).toContain("Number(event.recordCount)");
    expect(clientScript).toContain("event.firstOccurredAt||event.occurredAt");
    expect(clientScript).toContain('id="trace-toggle"');
    expect(clientScript).toContain("traceExpanded=!traceExpanded");
    expect(clientScript).not.toContain("detailRuns(story)");
    expect(clientScript).not.toContain("detailEvents(story)");
    expect(clientScript).not.toContain("story.lifecycle).length");
    expect(stylesheetText).toContain(".trace-row{display:grid");
    expect(clientScript).toContain('return story.attempts+" attempts"');
    expect(clientScript).toContain("discord\\.com\\/channels");
    expect(clientScript).toContain('url.searchParams.set("types"');
    expect(clientScript).toContain('url.searchParams.delete("types")');
    expect(clientScript).toContain("toggleActivityType");
    expect(clientScript).toContain("if(activityTypes.size===1)return");
    expect(clientScript).toContain("openTypeMenu");
    expect(clientScript).toContain("closeTypeMenu");
    expect(clientScript).toContain('["ArrowDown","ArrowUp"]');
    expect(clientScript).toContain('event.key==="Escape"');
    expect(clientScript).toContain('setAttribute("aria-selected"');
    expect(clientScript).toContain("if(refreshInFlight)return refreshInFlight");
    expect(clientScript).toContain("activityIndexInFlight?.query===query");
    expect(clientScript).toContain("if(latestSnapshot)renderActivity(latestSnapshot)");
    expect(clientScript).toContain("reconcileFilteredSelection");
    expect(clientScript).toContain('function setActivityFilter(filter){activityFilter=filter;updateActivityQuery();el("activity-scroll").scrollTo({top:0});if(latestSnapshot){renderActivity(latestSnapshot);reconcileFilteredSelection()}}');
    expect(clientScript).toContain('new URLSearchParams({filter:"all"');
    expect(clientScript).toContain("extra.limit||2000");
    expect(clientScript).toContain("activityDetailVersion");
    expect(clientScript).toContain("AbortController");
    expect(clientScript).toContain("Data stale · reconnecting automatically");
    expect(clientScript).toContain("activityNextCursor");
    expect(clientScript).toContain("ensureRouteStory");
    expect(clientScript).toContain("detailState.version===version");
    expect(clientScript).toContain("await refreshSnapshot()");
    expect(clientScript).toContain('renderChanged("activity"');
    expect(clientScript).toContain('revealView("dashboard-view","dashboard-loading")');
    expect(clientScript).toContain('removeAttribute("inert")');
    expect(clientScript).toContain('setAttribute("aria-busy","false")');
    expect(clientScript).not.toContain("setInterval(()=>");

    const overview = await fetch(`${baseUrl}/api/overview`);
    expect(overview.headers.get("cache-control")).toBe("no-store");
    await expect(overview.json()).resolves.toMatchObject({
      schemaVersion: 3,
      environment: "test",
      revision: "revision-a",
      summary: { serviceCount: 4, activeActivity: 0 },
    });
    const activityPayload = await fetch(`${baseUrl}/api/activity?types=conversation`).then((response) => response.json()) as { recent: Array<Record<string, unknown>> };
    expect(activityPayload.recent[0]).toMatchObject({ id: "runtime-example" });
    expect(activityPayload.recent[0]).not.toHaveProperty("technicalEvents");
    expect(activityPayload.recent[0]).not.toHaveProperty("lifecycle");
    expect(activityPayload.recent[0]).not.toHaveProperty("runs");

    const mutation = await fetch(`${baseUrl}/api/overview`, { method: "POST" });
    expect(mutation.status).toBe(405);

    const conversation = await fetch(`${baseUrl}/api/activity/conversation/runtime-example`);
    expect(conversation.status).toBe(200);
    await expect(conversation.json()).resolves.toMatchObject({
      schemaVersion: 2,
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

  it("paginates, filters, searches, and compresses the activity index", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    const activity = Array.from({ length: 3 }, (_, index) => ({
      id: `runtime-${index}`, kind: "runtime", title: `${index === 2 ? "Needle" : "Prompt"} ${"detail ".repeat(120)}`,
      status: index === 1 ? "failed" : "succeeded", occurredAt: new Date(Date.UTC(2026, 7, 6, 12, index)),
      startedAt: new Date(Date.UTC(2026, 7, 6, 11, index)), deliveryState: "delivered", events: [],
    }));
    const runtime = await startOperatorConsole({
      config,
      repository: {
        activityDetail: async () => null,
        snapshot: async () => ({
          generatedAt: new Date(), revision: "revision-a", services: [], summary: {}, executions: [], tasks: [],
          improvements: { counts: {}, cases: [] }, deployments: [], producers: [], activity,
        }),
      },
    });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const first = await fetch(`${baseUrl}/api/activity?types=conversation&limit=1`).then((response) => response.json()) as Record<string, unknown>;
    expect(first).toMatchObject({ total: 3, recent: [expect.objectContaining({ id: "runtime-2" })], nextCursor: expect.any(String) });
    const second = await fetch(`${baseUrl}/api/activity?types=conversation&limit=1&cursor=${encodeURIComponent(String(first.nextCursor))}`).then((response) => response.json()) as Record<string, unknown>;
    expect(second).toMatchObject({ recent: [expect.objectContaining({ id: "runtime-1" })] });
    await expect(fetch(`${baseUrl}/api/activity?types=conversation&filter=issues`).then((response) => response.json()))
      .resolves.toMatchObject({ total: 1, counts: expect.objectContaining({ issues: 1 }) });
    await expect(fetch(`${baseUrl}/api/activity?types=conversation&search=needle`).then((response) => response.json()))
      .resolves.toMatchObject({ total: 1, recent: [expect.objectContaining({ id: "runtime-2" })] });
    const compressed = await fetch(`${baseUrl}/api/activity?types=conversation&limit=100`, { headers: { "accept-encoding": "gzip" } });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    await expect(compressed.json()).resolves.toMatchObject({ total: 3 });
  });

  it("loads detail without invoking the complete projection", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    const snapshot = vi.fn(async () => { throw new Error("full projection should not run"); });
    const activityDetail = vi.fn(async () => ({ kind: "message", id: "message-a", message: { id: "a" } }));
    const runtime = await startOperatorConsole({ config, repository: { snapshot, activityDetail } });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");

    await expect(fetch(`http://127.0.0.1:${address.port}/api/activity/message/message-a`).then((response) => response.json()))
      .resolves.toMatchObject({ schemaVersion: 2, message: { id: "a" } });
    expect(activityDetail).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveBeenCalled();
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
    const overviewUrl = `http://127.0.0.1:${address.port}/api/overview`;
    const activityUrl = `http://127.0.0.1:${address.port}/api/activity`;

    const first = fetch(overviewUrl);
    const second = fetch(activityUrl);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    releaseFirst?.();
    await Promise.all([first, second]);
    await fetch(overviewUrl);

    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces only overlapping reads for the same activity detail", async () => {
    const config = loadConfig(["node", "test", "console"]);
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    let releaseFirst: (() => void) | undefined;
    const activityDetail = vi.fn(async ({ id }: { id: string }) => {
      if (id === "embedding" && activityDetail.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { id };
    });
    const runtime = await startOperatorConsole({
      config,
      repository: { snapshot: async () => ({}), activityDetail },
    });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}/api/activity/system`;

    const first = fetch(`${baseUrl}/embedding`);
    const second = fetch(`${baseUrl}/embedding`);
    const different = fetch(`${baseUrl}/release`);
    await vi.waitFor(() => expect(activityDetail).toHaveBeenCalledTimes(2));
    releaseFirst?.();
    await Promise.all([first, second, different]);
    await fetch(`${baseUrl}/embedding`);

    expect(activityDetail).toHaveBeenCalledTimes(3);
  });
});
