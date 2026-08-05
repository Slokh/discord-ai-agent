import { describe, expect, it } from "vitest";
import {
  qualityCohortIdentity,
  qualityCohortIdentityFromMetadata,
  runtimeVersionMetadata,
} from "../../src/observability/runtimeVersions.js";

describe("runtimeVersionMetadata", () => {
  it("returns stable content-addressed identifiers without configuration", () => {
    const first = runtimeVersionMetadata();
    const second = runtimeVersionMetadata(null);

    expect(first).toEqual(second);
    expect(first.appRevision).toBe("unknown");
    expect(first.promptVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.configVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.qualityRuntimeVersion).toBe("1");
    expect(first.qualityVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(qualityCohortIdentityFromMetadata(first)).toEqual({
      qualityVersion: first.qualityVersion,
      promptVersion: first.promptVersion,
      toolVersion: first.toolVersion,
      configVersion: first.configVersion,
      qualityRuntimeVersion: "1",
    });
  });

  it("changes the quality identity whenever a behavior component changes", () => {
    const base = qualityCohortIdentity({
      promptVersion: "prompt-a",
      toolVersion: "tool-a",
      configVersion: "config-a",
      qualityRuntimeVersion: "1",
    });
    const changed = qualityCohortIdentity({ ...base, toolVersion: "tool-b" });

    expect(changed.qualityVersion).not.toBe(base.qualityVersion);
    expect(qualityCohortIdentityFromMetadata({
      promptVersion: "prompt-a",
      toolVersion: "tool-a",
      configVersion: "config-a",
    })).toEqual(base);
  });
});
