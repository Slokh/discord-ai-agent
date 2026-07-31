import { describe, expect, it } from "vitest";
import { resolveProductionControlPlane } from "../../scripts/productionControlPlane.js";

describe("production control-plane resolution", () => {
  it("uses an explicit production target without a local fallback", () => {
    expect(resolveProductionControlPlane({
      apiUrl: "https://console.example.test/",
      auth: "production-password",
      env: {},
    })).toEqual({
      apiUrl: "https://console.example.test",
      auth: "production-password",
      source: "explicit",
    });
  });

  it("uses configured production environment access before Kubernetes discovery", () => {
    expect(resolveProductionControlPlane({
      env: {
        CONTROL_UI_PUBLIC_URL: "https://console.example.test/",
        CONTROL_UI_AUTH_PASSWORD: "production-password",
      },
    })).toEqual({
      apiUrl: "https://console.example.test",
      auth: "production-password",
      source: "environment",
    });
  });
});
