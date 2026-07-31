import { describe, expect, it } from "vitest";
import { parseTab } from "../../src/control/console/consoleRouting.js";

describe("console routing", () => {
  it("accepts only current detail tabs", () => {
    expect(parseTab("models")).toBe("models");
    expect(parseTab("calls")).toBe("overview");
    expect(parseTab("debugger")).toBe("overview");
  });

  it("falls back to the overview for unknown tabs", () => {
    expect(parseTab("unknown")).toBe("overview");
  });
});
