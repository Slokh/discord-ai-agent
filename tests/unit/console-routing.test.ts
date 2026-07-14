import { describe, expect, it } from "vitest";
import { parseTab } from "../../src/control/console/consoleRouting.js";

describe("console routing", () => {
  it("keeps legacy model-call links pointed at the prompt debugger", () => {
    expect(parseTab("calls")).toBe("models");
    expect(parseTab("debugger")).toBe("models");
    expect(parseTab("models")).toBe("models");
  });

  it("falls back to the overview for unknown tabs", () => {
    expect(parseTab("unknown")).toBe("overview");
  });
});
