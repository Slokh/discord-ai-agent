import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createDiscordConsoleAuthenticator } from "../../src/console/auth.js";
import { startOperatorConsole } from "../../src/console/server.js";

describe("hosted operator Console authentication", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("requires Discord OAuth and admits a member of the configured guild", async () => {
    const fetchDiscord = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "discord-access" });
      if (url.endsWith("/users/@me")) return Response.json({ id: "user-1" });
      if (url.includes("/users/@me/guilds")) return Response.json([{ id: "guild-1" }]);
      return new Response(null, { status: 404 });
    });
    const { baseUrl } = await startAuthenticatedConsole(fetchDiscord);

    const protectedPage = await fetch(`${baseUrl}/activity/conversation/run-1?filter=all`, { redirect: "manual" });
    expect(protectedPage.status).toBe(302);
    expect(protectedPage.headers.get("location")).toContain("/auth/login?returnTo=");

    const login = await fetch(`${baseUrl}${protectedPage.headers.get("location")}`, { redirect: "manual" });
    const discordLocation = new URL(login.headers.get("location")!);
    expect(discordLocation.origin).toBe("https://discord.com");
    expect(discordLocation.searchParams.get("scope")).toBe("identify guilds");
    expect(discordLocation.searchParams.get("redirect_uri")).toBe("https://console.mindcool.dev/auth/callback");
    const oauthCookie = cookiePair(login.headers.get("set-cookie"), "__Host-console_oauth");

    const callback = await fetch(
      `${baseUrl}/auth/callback?code=oauth-code&state=${encodeURIComponent(discordLocation.searchParams.get("state")!)}`,
      { headers: { cookie: oauthCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/activity/conversation/run-1?filter=all");
    const sessionCookie = cookiePair(callback.headers.get("set-cookie"), "__Host-console_session");
    expect(sessionCookie).toContain("__Host-console_session=");
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=2592000");

    const page = await fetch(`${baseUrl}/`, { headers: { cookie: sessionCookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Console</h1>");
    expect(fetchDiscord).toHaveBeenCalledTimes(3);
  });

  it("rejects authenticated Discord users outside the configured guild", async () => {
    const fetchDiscord = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "discord-access" });
      if (url.endsWith("/users/@me")) return Response.json({ id: "user-2" });
      return Response.json([{ id: "some-other-guild" }]);
    });
    const { baseUrl } = await startAuthenticatedConsole(fetchDiscord);
    const login = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const discordLocation = new URL(login.headers.get("location")!);
    const oauthCookie = cookiePair(login.headers.get("set-cookie"), "__Host-console_oauth");

    const callback = await fetch(
      `${baseUrl}/auth/callback?code=oauth-code&state=${encodeURIComponent(discordLocation.searchParams.get("state")!)}`,
      { headers: { cookie: oauthCookie }, redirect: "manual" },
    );

    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("only to members of the configured Discord server");
    expect(callback.headers.get("set-cookie")).toBeNull();
  });

  it("returns an authentication response for API calls without redirecting them", async () => {
    const { baseUrl } = await startAuthenticatedConsole(vi.fn());
    const response = await fetch(`${baseUrl}/api/overview`, { redirect: "manual" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_required" });
  });

  it("preserves trusted loopback access for the Kubernetes port-forward workflow", async () => {
    const { baseUrl } = await startAuthenticatedConsole(vi.fn(), true);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Console</h1>");
  });

  async function startAuthenticatedConsole(fetchDiscord: ReturnType<typeof vi.fn>, allowLoopbackAuthBypass = false) {
    const config = loadConfig(["node", "test", "console"]);
    config.nodeEnv = "production";
    config.appRevision = "revision-a";
    config.consoleServer = { host: "127.0.0.1", port: 0 };
    config.consoleAuth = {
      publicUrl: "https://console.mindcool.dev",
      clientId: "client-1",
      clientSecret: "client-secret",
      guildId: "guild-1",
      sessionSecret: "session-secret-with-enough-entropy",
    };
    const runtime = await startOperatorConsole({
      config,
      repository: { snapshot: async () => ({}), activityDetail: async () => null },
      authenticator: createDiscordConsoleAuthenticator(config.consoleAuth, { fetch: fetchDiscord as typeof fetch }),
      allowLoopbackAuthBypass,
    });
    close = runtime.close;
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Console did not bind a TCP port.");
    return { baseUrl: `http://127.0.0.1:${address.port}` };
  }
});

function cookiePair(header: string | null, name: string) {
  const match = header?.match(new RegExp(`(?:^|, )(${name}=[^;]+)`));
  if (!match?.[1]) throw new Error(`Missing ${name} cookie.`);
  return match[1];
}
