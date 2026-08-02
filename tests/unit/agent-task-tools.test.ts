import { describe, expect, it, vi } from "vitest";
import { cancelAgentTask, listAgentTasks } from "../../src/tools/agentTaskTools.js";
import type { ToolContext } from "../../src/tools/types.js";

const task = {
  taskId: "task-1",
  guildId: "guild-1",
  channelId: "channel-1",
  status: "running",
  title: "Update the agent",
  request: "make the requested update",
  backend: "local-process-sandbox",
  createdAt: new Date("2026-07-31T12:00:00.000Z"),
  updatedAt: new Date("2026-07-31T12:01:00.000Z"),
};

describe("agent task tools", () => {
  it("normalizes filters and lists requester-visible tasks", async () => {
    const listTasks = vi.fn(async () => [task]);
    const auditTool = vi.fn(async () => undefined);
    const ctx = context({ listAgentTasks: listTasks, auditTool });

    const response = await listAgentTasks(ctx, {
      statuses: [" running ", "invalid", "running"],
      limit: 100,
    });

    expect(response).toContain("Recent agent tasks:");
    expect(response).toContain("task-1");
    expect(listTasks).toHaveBeenCalledWith({
      guildId: "guild-1",
      visibleChannelIds: ["channel-1"],
      statuses: ["running"],
      limit: 20,
    });
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "listAgentTasks",
      resultSummary: expect.stringContaining('"tasks":1'),
    }));
  });

  it("cancels an explicitly selected visible active task", async () => {
    const cancelTask = vi.fn(async () => true);
    const auditTool = vi.fn(async () => undefined);
    const ctx = context({
      getAgentTask: vi.fn(async () => task),
      cancelAgentTask: cancelTask,
      auditTool,
    });

    await expect(cancelAgentTask(ctx, { taskId: " task-1 ", reason: "not needed" }))
      .resolves.toEqual(expect.objectContaining({
        content: expect.stringContaining("Cancelled agent task `task-1`"),
        outcome: expect.objectContaining({ terminal: true }),
      }));

    expect(cancelTask).toHaveBeenCalledWith({ taskId: "task-1", reason: "not needed" });
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "cancelAgentTask" }));
  });
});

function context(repo: Record<string, unknown>): ToolContext {
  return {
    repo,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    userDisplayName: "Kartik",
    visibleChannelIds: ["channel-1"],
  } as unknown as ToolContext;
}
