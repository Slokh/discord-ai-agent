import { describe, expect, it } from "vitest";
import { applyRunSnapshotDelta, type RunSnapshotDelta } from "../../src/control/console/api.js";
import { fixtureSnapshots } from "../../src/control/console/fixtures.js";

describe("console incremental run stream", () => {
  it("appends unique runtime records and updates lightweight run state", () => {
    const current = fixtureSnapshots[0];
    const addedEvent = { ...current.events[0], id: "new-event", summary: "incremental" };
    const delta: RunSnapshotDelta = {
      run: { ...current.run, status: "running", updatedAt: "2026-07-11T00:00:00.000Z" },
      spans: [],
      events: [addedEvent],
      artifacts: [],
      agentTranscript: [],
      terminal: null,
      diagnostics: ["updated"],
      raw: current.raw,
      relatedRuns: current.relatedRuns,
      generatedAt: "2026-07-11T00:00:00.000Z",
    };
    const next = applyRunSnapshotDelta(current, delta);
    expect(next.run.status).toBe("running");
    expect(next.events.at(-1)).toEqual(addedEvent);
    expect(next.events.filter((event) => event.id === addedEvent.id)).toHaveLength(1);
    expect(next.diagnostics).toEqual(["updated"]);
  });
});
