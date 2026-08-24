import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { announceDeployment, __test } from "../../src/discord/deploymentAnnouncements.js";
import { BUG_FIX_TITLE, formatUpdateAnnouncement } from "../../src/discord/updateAnnouncements.js";

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
    releaseNotes: { verificationId: null, previousRevision: oldRevision },
    discord: { ...loadConfig().discord, guildId: "guild-1", botChannelId: "release-channel" },
    github: { ...loadConfig().github, repository: "example-org/example-agent", token: undefined }
  };
  const repo = {
    latestDeploymentRevision: vi.fn().mockResolvedValue(null),
    recordDeploymentBaseline: vi.fn().mockResolvedValue(undefined),
    claimDeploymentAnnouncement: vi.fn().mockResolvedValue(true),
    markDeploymentAnnouncementPosted: vi.fn().mockResolvedValue(undefined),
    markDeploymentAnnouncementFailed: vi.fn().mockResolvedValue(undefined),
    markDeploymentAnnouncementSkipped: vi.fn().mockResolvedValue(undefined),
    recordTraceEvent: vi.fn().mockResolvedValue(undefined),
    auditTool: vi.fn().mockResolvedValue(undefined)
  };
  const openRouter = {
    chat: vi.fn().mockResolvedValue({
      content: "- Casino games now keep working across replies.\n- Tables are easier to read.",
      model: "utility-model",
      finishReason: "stop",
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
      reasoningEffort: "medium",
      toolChoice: "none"
    }));
    const modelMessages = fixture.openRouter.chat.mock.calls[0]?.[0].messages;
    expect(modelMessages[0]?.content).toContain("curious Discord community in plain English");
    expect(modelMessages[0]?.content).toContain("Explain what changed and why it matters");
    expect(modelMessages[0]?.content).toContain("Translate the evidence into language that makes sense without repository context");
    expect(modelMessages[0]?.content).toContain("explain what it does or what changed in the same bullet");
    expect(modelMessages[0]?.content).toContain("Describe internal maintenance directly");
    expect(modelMessages[0]?.content).not.toContain("say it is a small behind-the-scenes reliability update");
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("## ✨ Bot update\n- Casino games now keep working across replies."),
      allowedMentions: { parse: [] }
    }));
    expect(fixture.send.mock.calls[0]?.[0].content).toContain(`[See everything in version ${newRevision.slice(0, 7)}](<https://github.com/example-org/example-agent/compare/${oldRevision}...${newRevision}>)`);
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

  it("records Console-only deploys without contacting Discord or generating bot updates", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      status: "ahead",
      ahead_by: 1,
      files: [{ filename: "src/console/client.ts", status: "modified", additions: 10, deletions: 2 }],
    }), { status: 200 }));

    await expect(announceDeployment(fixture as any)).resolves.toBe("skipped");
    expect(fixture.client.channels.fetch).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.openRouter.chat).not.toHaveBeenCalled();
    expect(fixture.repo.markDeploymentAnnouncementSkipped).toHaveBeenCalledWith({
      guildId: "guild-1",
      revision: newRevision,
      comparisonUrl: `https://github.com/example-org/example-agent/compare/${oldRevision}...${newRevision}`,
    });
  });

  it("keeps announcements for a diff that includes a member-facing change", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      status: "ahead",
      ahead_by: 2,
      files: [
        { filename: "src/console/client.ts", status: "modified" },
        { filename: "src/discord/responseSink.ts", status: "modified" },
      ],
    }), { status: 200 }));

    await expect(announceDeployment(fixture as any)).resolves.toBe("posted");
    expect(fixture.send).toHaveBeenCalledOnce();
  });

  it("does not duplicate an announcement already visible in Discord after a crash", async () => {
    const fixture = setup();
    fixture.messages.fetch.mockResolvedValue([{ id: "existing", author: { id: "bot-1" }, content: `-# <https://github.com/x/y/compare/${oldRevision}...${newRevision}>` }] as any);

    await expect(announceDeployment(fixture as any)).resolves.toBe("duplicate");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.repo.markDeploymentAnnouncementPosted).toHaveBeenCalledWith(expect.objectContaining({ discordMessageId: "existing" }));
  });

  it("publishes release-wide notes even when contextual bug-fix updates were delivered", async () => {
    const fixture = setup();
    await expect(announceDeployment({
      ...fixture,
      deliveredBugFix: { content: "## 🐛 Bug fix\n- Better retries.", messageId: "bug-fix-update-1" },
    } as any)).resolves.toBe("posted");

    expect(fixture.client.channels.fetch).toHaveBeenCalledWith("release-channel");
    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("## ✨ Bot update"),
    }));
    expect(fixture.repo.markDeploymentAnnouncementPosted).toHaveBeenCalledWith(expect.objectContaining({
      discordMessageId: "announcement-1",
    }));
  });

  it("falls back to bounded commit summaries when the utility model is unavailable", async () => {
    const fixture = setup();
    fixture.openRouter.chat.mockRejectedValue(new Error("provider down"));

    await expect(announceDeployment(fixture as any)).resolves.toBe("posted");
    expect(fixture.send.mock.calls[0]?.[0].content).toContain("- Fix durable games");
  });

  it("falls back to concrete changed files when commit summaries are unavailable", async () => {
    const fixture = setup();
    fixture.openRouter.chat.mockRejectedValue(new Error("provider down"));
    fixture.fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      status: "ahead",
      ahead_by: 1,
      commits: [],
      files: [{ filename: "src/observability/revisionQuality.ts", status: "modified", additions: 28, deletions: 0 }]
    }), { status: 200 }));

    await expect(announceDeployment(fixture as any)).resolves.toBe("posted");
    expect(fixture.send.mock.calls[0]?.[0].content)
      .toContain("- modified src/observability/revisionQuality.ts (+28/-0).");
    expect(fixture.send.mock.calls[0]?.[0].content).not.toContain("behind-the-scenes");
  });

  it("falls back instead of publishing a token-truncated or structurally incomplete model bullet", async () => {
    const truncated = setup();
    truncated.openRouter.chat.mockResolvedValue({
      content: '- “Improved the reporting workflow',
      model: "utility-model",
      finishReason: "length",
      estimatedCostUsd: 0.001,
    });

    await expect(announceDeployment(truncated as any)).resolves.toBe("posted");
    expect(truncated.send.mock.calls[0]?.[0].content).toContain("- Fix durable games");
    expect(truncated.send.mock.calls[0]?.[0].content).not.toContain("reporting workflow");

    expect(__test.patchNotesLookComplete('- “Improved the reporting workflow')).toBe(false);
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

  it("formats deployed updates as a prominent heading with a compact linked footer", () => {
    expect(__test.formatAnnouncement("- Better replies.", "example/repo", oldRevision, newRevision)).toBe(
      `## ✨ Bot update\n- Better replies.\n\n-# [See everything in version ${newRevision.slice(0, 7)}](<https://github.com/example/repo/compare/${oldRevision}...${newRevision}>)`
    );
  });

  it("uses the same update layout for a contextual bug fix", () => {
    expect(formatUpdateAnnouncement({
      body: "- Better replies.",
      repository: "example/repo",
      base: oldRevision,
      head: newRevision,
      title: BUG_FIX_TITLE,
    })).toBe(
      `## 🐛 Bug fix\n- Better replies.\n\n-# [See everything in version ${newRevision.slice(0, 7)}](<https://github.com/example/repo/compare/${oldRevision}...${newRevision}>)`
    );
  });
});
