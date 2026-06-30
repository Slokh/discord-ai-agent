import { describe, expect, it } from "vitest";
import { verifyUiAuthorization } from "../../src/control/internalApi.js";

describe("internal API UI authorization", () => {
  it("allows UI access when no password is configured", () => {
    expect(verifyUiAuthorization({ password: "" })).toBe(true);
  });

  it("accepts the configured password through browser Basic auth", () => {
    const authorization = `Basic ${Buffer.from("admin:secret-password").toString("base64")}`;

    expect(verifyUiAuthorization({ password: "secret-password", authorization })).toBe(true);
  });

  it("accepts the configured password through bearer auth for scripts", () => {
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer secret-password" })).toBe(true);
  });

  it("accepts the configured password through the persisted UI cookie", () => {
    expect(
      verifyUiAuthorization({
        password: "secret-password",
        cookie: "other=value; discord_ai_agent_ui_auth=secret-password"
      })
    ).toBe(true);
  });

  it("rejects missing, wrong, or malformed credentials", () => {
    expect(verifyUiAuthorization({ password: "secret-password" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer wrong" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", cookie: "discord_ai_agent_ui_auth=wrong" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Basic nope" })).toBe(false);
    expect(
      verifyUiAuthorization({
        password: "secret-password",
        authorization: `Basic ${Buffer.from("not-admin:secret-password").toString("base64")}`
      })
    ).toBe(false);
  });
});
