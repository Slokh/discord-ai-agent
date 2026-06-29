import { describe, expect, it } from "vitest";
import { CodexActivityTracker, type CodexActivitySnapshot } from "../../src/codegen/activity.js";

describe("CodexActivityTracker", () => {
  it("tracks Codex JSONL command, reasoning, file change, and final summaries", () => {
    let now = 0;
    const snapshots: CodexActivitySnapshot[] = [];
    const tracker = new CodexActivityTracker({
      intervalMs: 1000,
      now: () => now,
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    });

    tracker.acceptStdout(jsonLine({ type: "turn.plan.updated", plan: [{ step: "Inspect code", status: "in_progress" }] }));
    now += 400;
    tracker.acceptStdout(jsonLine({ type: "item.reasoning.summaryTextDelta", itemId: "reasoning-1", delta: "I should inspect the Discord client." }));
    now += 700;
    tracker.acceptStdout(jsonLine({ type: "item.started", item: { id: "cmd-1", type: "commandExecution", command: "/bin/bash -lc 'rg mention src/discord/client.ts'" } }));
    now += 300;
    tracker.acceptStdout(jsonLine({ type: "item.completed", item: { id: "cmd-1", type: "commandExecution", command: "/bin/bash -lc 'rg mention src/discord/client.ts'", exitCode: 0 } }));
    now += 200;
    tracker.acceptStdout(
      jsonLine({
        type: "item.completed",
        item: {
          id: "file-1",
          type: "fileChange",
          changes: [{ path: "src/discord/client.ts", diff: "@@ example" }]
        }
      })
    );
    now += 100;
    tracker.acceptStdout(jsonLine({ type: "result", result: "done" }));
    now += 1500;
    tracker.heartbeat();

    const final = tracker.finish();

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(final.final).toBe(true);
    expect(final.totalEvents).toBe(6);
    expect(final.eventTypes["item.started"]).toBe(1);
    expect(final.eventTypes["item.completed"]).toBe(2);
    expect(final.planUpdates).toBe(1);
    expect(final.reasoningChars).toBe("I should inspect the Discord client.".length);
    expect(final.reasoningSnippets).toEqual(["I should inspect the Discord client."]);
    expect(final.commandStarts).toBe(1);
    expect(final.commandCompletions).toBe(1);
    expect(final.commandFailures).toBe(0);
    expect(final.lastCommand).toBe("rg mention src/discord/client.ts");
    expect(final.recentCommands).toContainEqual({ command: "rg mention src/discord/client.ts", status: "completed", durationMs: 300, exitCode: 0 });
    expect(final.fileChangeCompletions).toBe(1);
    expect(final.filePaths).toEqual(["src/discord/client.ts"]);
    expect(final.recentFileChanges).toEqual(["src/discord/client.ts"]);
    expect(final.planSnippets).toEqual(["Inspect code"]);
    expect(final.silentForMs).toBe(1500);
    expect(final.longestOutputGapMs).toBe(1500);
    expect(final.recentActivities.at(-1)).toBe("Codex terminal event");
    expect(final.phaseDurationsMs.command).toBeGreaterThan(0);
  });

  it("keeps running when stdout contains non-json lines or split json chunks", () => {
    let now = 0;
    const tracker = new CodexActivityTracker({ now: () => now });
    const event = JSON.stringify({ type: "item.agentMessage.delta", delta: "hello" });

    tracker.acceptStdout("not json\n");
    tracker.acceptStderr("2026-06-29T20:41:31Z ERROR codex_core::util: ReasoningRawContentDelta without active item\n");
    tracker.acceptStdout(event.slice(0, 10));
    now += 5;
    tracker.acceptStdout(`${event.slice(10)}\n`);

    const final = tracker.finish();

    expect(final.nonJsonLines).toBe(1);
    expect(final.stderrBytes).toBeGreaterThan(0);
    expect(final.stderrSnippets).toEqual(["2026-06-29T20:41:31Z ERROR codex_core::util: ReasoningRawContentDelta without active item"]);
    expect(final.totalEvents).toBe(1);
    expect(final.messageChars).toBe(5);
  });

  it("surfaces repeated commands so codegen loops are obvious", () => {
    let now = 0;
    const tracker = new CodexActivityTracker({ now: () => now });

    for (const id of ["cmd-1", "cmd-2"]) {
      tracker.acceptStdout(jsonLine({ type: "item.started", item: { id, type: "commandExecution", command: "git diff -- src/codegen/runner.ts" } }));
      now += 100;
      tracker.acceptStdout(jsonLine({ type: "item.completed", item: { id, type: "commandExecution", command: "git diff -- src/codegen/runner.ts", exitCode: 0 } }));
      now += 100;
    }

    const final = tracker.finish();

    expect(final.commandStarts).toBe(2);
    expect(final.commandCompletions).toBe(2);
    expect(final.repeatedCommands).toEqual([{ command: "git diff -- src/codegen/runner.ts", count: 2 }]);
  });
});

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}
