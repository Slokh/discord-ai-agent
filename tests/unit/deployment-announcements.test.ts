import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { announceDeployment, __test } from "../../src/discord/deploymentAnnouncements.js";

const oldRevision = "a".repeat(40);
const newRevision = "b".repeat(40);

function setup() {
  const send = vi.fn().mockResolvedValue({ id: "announcement-1" });
  const messages = { fetch: vi.fn().mockResolvedValue([]) };
  const channel = { send, messages, client: { user: { id: "bot-1" } } };
  const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };
  const config: AppConfig = {
    ...loadConfig(),
    appRevision: newRevision,
    releaseNotes: { channelId: "release-channel", previousRevision: oldRevision },
    discord: { ...loadConfig().discord, guildId: "guild-1" },
    github: { ...loadConfig().github, repository: "example-org/example-agent", token: undefined }
  };
  const repo = {
    latestDeploymentRevision: vi.fn().mockResolvedValue(null),
    recordDeploymentBaseline: vi.fn().mockResolvedValue(undefined),
    claimDeploymentAnnouncement: vi.fn().mockResolvedValue(true),
    markDeploymentAnnouncementPosted: vi.fn().mockResolvedValue(undefined),
    markDeploymentAnnouncementFailed: vi.fn().mockResolvedValue(undefined),
    recordTraceEvent: vi.fn().mockResolvedValue(undefined),
    auditTool: vi.fn().mockResolvedValue(undefined)
  };
  const openRouter = {
    chat: vi.fn().mockResolvedValue({
      content: "- Casino games now keep working across replies.\n- Tables are easier to read.",
      model: "utility-model",
      estimatedCostUsd: 0.001
    })
  };
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    status: "ahead",
    ahead_by: 2,
    commits: [{ commit: { message: "Fix durable games" } }, { commit: { message: "Improve table rendering" } }],
    files: [{ filename: "src/games.ts", status: "modified", additions: 10, deletions: 2, patch: "+ durable state" }]
  }), { status: 200 }));
  return { client, channel, send, messages, config, repo, openRouter, fetchImpl };
}

describe("deployment announcements", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts AI-written notes for the exact deployed comparison and records the result", async () => {
    const fixture = setup();
    await expect(announceDeployment(fixture as any)).resolves.toBe("posted");

    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/compare/${oldRevision}...${newRevision}`),
      expect.any(Object)
    );
    expect(fixture.openRouter.chat).toHaveBeenCalledWith(expect.objectContaining({
      model: fixture.config.openRouter.utilityModel,
      toolChoice: "none"
    }));
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("**Bot update**\n- Casino games now keep working across replies."),
      allowedMentions: { parse: [] }
    }));
    expect(fixture.send.mock.calls[0]?.[0].content).toContain(`<https://github.com/example-org/example-agent/compare/${oldRevision}...${newRevision}>`);
    expect(fixture.repo.markDeploymentAnnouncementPosted).toHaveBeenCalledWith(expect.objectContaining({
      revision: newRevision,
      discordMessageId: "announcement-1"
    }));
  });

  it("records a baseline instead of inventing a diff on the first configured startup", async () => {
    const fixture = setup();
    fixture.config.releaseNotes.previousRevision = null;
    fixture.repo.latestDeploymentRevision.mockResolvedValue(null);

    await expect(announceDeployment(fixture as any)).resolves.toBe("baseline");
    expect(fixture.repo.recordDeploymentBaseline).toHaveBeenCalledOnce();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("does not duplicate an announcement already visible in Discord after a crash", async () => {
    const fixture = setup();
    fixture.messages.fetch.mockResolvedValue([{ id: "existing", author: { id: "bot-1" }, content: `-# <https://github.com/x/y/compare/${oldRevision}...${newRevision}>` }] as any);

    await expect(announceDeployment(fixture as any)).resolves.toBe("duplicate");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.repo.markDeploymentAnnouncementPosted).toHaveBeenCalledWith(expect.objectContaining({ discordMessageId: "existing" }));
  });

  it("falls back to bounded commit summaries when the utility model is unavailable", async () => {
    const fixture = setup();
    fixture.openRouter.chat.mockRejectedValue(new Error("provider down"));

    await expect(announceDeployment(fixture as any)).resolves.toBe("posted");
    expect(fixture.send.mock.calls[0]?.[0].content).toContain("- Fix durable games");
  });

  it("marks a comparison failure for a later retry without posting guesses", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(announceDeployment(fixture as any)).rejects.toThrow(/GitHub compare failed \(404\)/);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.repo.markDeploymentAnnouncementFailed).toHaveBeenCalledWith(expect.objectContaining({
      revision: newRevision,
      error: expect.stringContaining("GitHub compare failed (404)")
    }));
  });

  it("normalizes model output to at most five safe bullets", () => {
    expect(__test.normalizePatchNotes("# Notes\n* one\n- two <@123>\n- three\n- four\n- five\n- six"))
      .toBe("- one\n- two someone\n- three\n- four\n- five");
  });
});
