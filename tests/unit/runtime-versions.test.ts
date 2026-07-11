import { describe, expect, it } from "vitest";
import { runtimeVersionMetadata } from "../../src/observability/runtimeVersions.js";

describe("runtimeVersionMetadata", () => {
  it("returns stable content-addressed identifiers without configuration", () => {
    const first = runtimeVersionMetadata();
    const second = runtimeVersionMetadata(null);

    expect(first).toEqual(second);
    expect(first.appRevision).toBe("unknown");
    expect(first.promptVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.configVersion).toMatch(/^[a-f0-9]{64}$/);
  });
});
