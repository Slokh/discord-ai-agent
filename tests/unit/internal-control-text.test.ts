import { describe, expect, it } from "vitest";
import { isInternalControlText } from "../../src/agent/internalControlText.js";

describe("internal control conversation boundary", () => {
  it("rejects known prompt-control text from assistant memory", () => {
    expect(isInternalControlText("The final user message is the current request and always determines the task.")).toBe(true);
  });

  it("keeps ordinary assistant conversation eligible for memory", () => {
    expect(isInternalControlText("Your balance is $8.")).toBe(false);
  });
});
