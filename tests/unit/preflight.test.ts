import { describe, expect, it, vi } from "vitest";
import { preflightSteps, runPreflight, type PreflightStep } from "../../scripts/preflight.js";

describe("preflight runner", () => {
  it("runs the local acceptance commands in order", () => {
    expect(preflightSteps.map((step) => [step.command, ...step.args].join(" "))).toEqual([
      "docker compose up -d postgres",
      "npm run migrate",
      "npm run doctor",
      "npm run invite-url",
      "npm run smoke:discord",
      "npm run smoke:openrouter",
      "npm run smoke:github",
      "npm run smoke:startup",
      "npm run clear-commands"
    ]);
  });

  it("stops at the first failing step", async () => {
    const steps: PreflightStep[] = [
      { label: "first", command: "ok", args: [] },
      { label: "second", command: "fail", args: [] },
      { label: "third", command: "skip", args: [] }
    ];
    const seen: string[] = [];
    const runner = vi.fn(async (step: PreflightStep) => {
      seen.push(step.label);
      return step.label === "second" ? 1 : 0;
    });

    await expect(runPreflight(steps, runner, () => undefined)).rejects.toThrow('Preflight failed at "second"');

    expect(seen).toEqual(["first", "second"]);
  });
});
