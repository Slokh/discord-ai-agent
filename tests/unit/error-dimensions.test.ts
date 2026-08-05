import { describe, expect, it } from "vitest";
import { runtimeErrorDimensions } from "../../src/observability/errorDimensions.js";

describe("runtimeErrorDimensions", () => {
  it("normalizes only content-free failure dimensions", () => {
    class ProviderTimeout extends Error {
      name = "ProviderTimeout";
      code = "ETIMEDOUT/private detail";
      status = 504;
    }
    const error = new ProviderTimeout("secret provider response");

    expect(runtimeErrorDimensions(error)).toEqual({
      errorKind: "providertimeout",
      errorCode: "etimedout_private_detail",
      errorStatus: 504,
    });
    expect(JSON.stringify(runtimeErrorDimensions(error))).not.toContain("secret provider response");
  });

  it("drops invalid status and bounds arbitrary error shapes", () => {
    expect(runtimeErrorDimensions({ name: "  Upstream Failure?!  ", code: 22, status: 900 }))
      .toEqual({ errorKind: "upstream_failure" });
  });
});
