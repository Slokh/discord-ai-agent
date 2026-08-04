import { describe, expect, it } from "vitest";
import { resolveProductionControlPlane } from "../../scripts/productionControlPlane.js";

describe("production control-plane resolution", () => {
  it("uses an explicit production target without a local fallback", () => {
    expect(resolveProductionControlPlane({
      apiUrl: "https://control.example.test/",
      auth: "production-password",
      env: {},
    })).toEqual({
      apiUrl: "https://control.example.test",
      auth: "production-password",
      source: "explicit",
    });
  });

  it("uses configured production environment access before Kubernetes discovery", () => {
    expect(resolveProductionControlPlane({
      env: {
        CONTROL_API_PUBLIC_URL: "https://control.example.test/",
        CONTROL_API_AUTH_PASSWORD: "production-password",
      },
    })).toEqual({
      apiUrl: "https://control.example.test",
      auth: "production-password",
      source: "environment",
    });
  });
});
