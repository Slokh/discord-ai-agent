export const dashboardPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Discord AI Agent · Console</title>
  <link rel="stylesheet" href="/assets/styles.css?v=1">
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="dashboard-title"><h1>Console</h1><div id="environment" class="environment">—</div><div id="revision" class="revision" tabindex="0" aria-describedby="release-tooltip"><span id="revision-text">revision —</span><span id="release-tooltip" class="status-tooltip release-tooltip" role="tooltip"></span></div></div>
      <section class="topbar-system" aria-label="System status">
        <div class="system-segments">
          <div class="status-segment" tabindex="0" aria-describedby="services-tooltip"><span id="service-summary">— services</span><div id="services-tooltip" class="status-tooltip" role="tooltip"></div></div>
          <div class="status-segment" tabindex="0" aria-describedby="producers-tooltip"><span id="producer-summary">— producers</span><div id="producers-tooltip" class="status-tooltip" role="tooltip"></div></div>
        </div>
      </section>
    </header>

    <div class="console-content">
    <div id="dashboard-loading" class="loading-shell overview-loading" role="status" aria-live="polite">
      <span class="sr-only loading-status">Loading production data</span>
      <div class="loading-error" hidden><strong>Production data unavailable</strong><span>The Console will retry automatically.</span></div>
      <div class="loading-visual" aria-hidden="true">
        <div class="loading-workspace">
          <div class="loading-panel loading-activity">
            <div class="loading-heading"><span class="skeleton-line w-24"></span><span class="skeleton-pill wide"></span></div>
            ${Array.from({ length: 8 }, (_, index) => `<div class="loading-row"><span class="skeleton-dot"></span><span><span class="skeleton-line w-${index % 3 === 0 ? 52 : 42}"></span><span class="skeleton-line w-24"></span></span><span class="skeleton-line w-12"></span></div>`).join("")}
          </div>
          <div class="loading-detail-pane">
            <div class="loading-detail-hero"><span class="skeleton-line w-24"></span><span class="skeleton-line w-52 tall"></span><span class="skeleton-line w-34"></span></div>
            <div class="loading-detail-metrics">${Array.from({ length: 4 }, () => '<span><i class="skeleton-line w-34"></i><i class="skeleton-line w-52"></i></span>').join("")}</div>
            <div class="loading-panel loading-detail-section">${Array.from({ length: 4 }, (_, index) => `<div class="loading-row"><span class="skeleton-dot"></span><span><span class="skeleton-line w-${index % 2 === 0 ? 42 : 34}"></span><span class="skeleton-line w-24"></span></span></div>`).join("")}</div>
          </div>
        </div>
      </div>
    </div>

    <div id="dashboard-view" class="loading-target" aria-busy="true" inert>
    <div class="console-workspace">
      <section id="activity-panel" class="panel activity-panel" aria-label="Activity">
        <div class="activity-filter-controls">
          <div class="activity-filters" role="group" aria-label="Filter activity by status"><button type="button" data-activity-filter="all" aria-pressed="true">All <span id="filter-all-count">0</span></button><button type="button" data-activity-filter="running" aria-pressed="false">Running <span id="filter-running-count">0</span></button><button type="button" data-activity-filter="waiting" aria-pressed="false">Waiting <span id="filter-waiting-count">0</span></button><button type="button" data-activity-filter="blocked" aria-pressed="false">Blocked <span id="filter-blocked-count">0</span></button><button type="button" data-activity-filter="failed" aria-pressed="false">Failed <span id="filter-failed-count">0</span></button><button type="button" data-activity-filter="done" aria-pressed="false">Done <span id="filter-done-count">0</span></button></div>
          <div class="activity-type-filter"><span>Type</span><div id="activity-type-menu" class="activity-type-menu"><button id="activity-type-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="activity-type-options"><span id="activity-type-label">All types</span><span class="activity-type-chevron" aria-hidden="true"></span></button><div id="activity-type-options" class="activity-type-options" role="listbox" aria-label="Filter activity by type" hidden><button type="button" role="option" data-activity-type="all" aria-selected="true">All types</button><button type="button" role="option" data-activity-type="conversation" aria-selected="false">Prompts &amp; replies</button><button type="button" role="option" data-activity-type="improvement" aria-selected="false">Improvements</button><button type="button" role="option" data-activity-type="code_change" aria-selected="false">Code changes</button><button type="button" role="option" data-activity-type="release" aria-selected="false">Releases</button><button type="button" role="option" data-activity-type="system" aria-selected="false">System</button></div></div></div>
        </div>
        <div id="activity-scroll" class="activity-scroll"><div id="active-activity" class="active-activity"></div><div id="activity" class="timeline"></div></div>
      </section>
      <section id="activity-detail-view" class="activity-detail-view workspace-detail">
        <a id="activity-back" class="back-link" href="/?filter=all#activity-panel">← Activity</a>
        <div id="activity-detail"><div class="detail-placeholder"><span class="terminal-prompt" aria-hidden="true">›_</span><h2>Select activity</h2><p>Choose an item to inspect its context and execution details.</p></div></div>
      </section>
    </div>
    </div>
    <dialog id="activity-search" class="activity-search" aria-labelledby="activity-search-title">
      <h2 id="activity-search-title" class="sr-only">Search activity</h2>
      <div class="activity-search-input-row"><span class="activity-search-icon" aria-hidden="true"></span><input id="activity-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search activity" role="combobox" aria-autocomplete="list" aria-controls="activity-search-results" aria-expanded="false"><kbd>Esc</kbd></div>
      <div id="activity-search-results" class="activity-search-results" role="listbox" aria-label="Activity search results"></div>
      <footer class="activity-search-help" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
    </dialog>
    </div>
  </main>
  <script src="/assets/app.js?v=1" defer></script>
</body>
</html>`;

export function renderDashboardPage(liveReload = false, _detailView = false) {
  const page = dashboardPage;
  if (!liveReload) return page;
  return page.replace(
    '  <script src="/assets/app.js?v=1" defer></script>',
    '  <script src="/assets/reload.js?v=1" defer></script>\n  <script src="/assets/app.js?v=1" defer></script>',
  );
}
