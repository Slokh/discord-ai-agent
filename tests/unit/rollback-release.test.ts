import { describe, expect, it, vi } from "vitest";
import { revisionFromHelmValues, rollbackRelease } from "../../scripts/rollbackRelease.js";

describe("Helm release rollback", () => {
  it("derives the immutable application revision from target values", () => {
    expect(revisionFromHelmValues({ config: { appRevision: "revision-a" }, image: { tag: "fallback" } })).toBe("revision-a");
    expect(revisionFromHelmValues({ image: { tag: "revision-b" } })).toBe("revision-b");
    expect(() => revisionFromHelmValues({})).toThrow(/does not declare/i);
  });

  it("uses Helm ownership and verifies a restart-free rollback", async () => {
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "helm" && args[0] === "get") return JSON.stringify({ config: { appRevision: "revision-a" } });
      return "";
    });
    const verify = vi.fn(async () => ({ healthy: true, revision: "revision-a", components: [], issues: [] }));
    await expect(rollbackRelease({ helmRevision: 41, runner, verify, stabilitySeconds: 15 })).resolves.toMatchObject({
      helmRevision: 41,
      expectedRevision: "revision-a",
    });
    expect(runner).toHaveBeenCalledWith("helm", expect.arrayContaining([
      "rollback", "discord-ai-agent", "41", "--force-conflicts", "--wait-for-jobs",
    ]));
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: "revision-a", stabilitySeconds: 15 }));
  });
});
