import { describe, expect, it } from "vitest";
import { formatBugStatus } from "../../scripts/discordBugStatus.js";

describe("Discord bug status formatter", () => {
  it("shows lifecycle state without Discord message content or links", () => {
    const output = formatBugStatus({
      generatedAt: "2026-08-03T00:00:00.000Z",
      requesterUserId: "123456789012345678",
      counts: { total: 1, awaitingValidation: 0, awaitingDeployment: 0, retryFailed: 0 },
      items: [{
        markedAt: new Date("2026-08-02T00:00:00.000Z"),
        validationStatus: "completed",
        disposition: "confirmed_fixed",
        prUrl: "https://github.com/example/repo/pull/12",
        deployedRevision: "revision-a",
        retryStatus: "succeeded",
        updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    });
    expect(output).toContain("original prompt retry: succeeded");
    expect(output).toContain("https://github.com/example/repo/pull/12");
    expect(output).not.toContain("discord.com/channels");
    expect(output).not.toContain("123456789012345678");
  });
});
