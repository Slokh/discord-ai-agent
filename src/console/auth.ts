import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config/env.js";

const SESSION_COOKIE = "__Host-console_session";
const STATE_COOKIE = "__Host-console_oauth";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const STATE_TTL_MS = 10 * 60 * 1_000;
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";

type SignedPayload = {
  expiresAt: number;
  guildId: string;
  nonce?: string;
  returnTo?: string;
  userId?: string;
};

export type ConsoleAuthResult = "handled" | "authorized" | "unauthorized";

export type ConsoleAuthenticator = {
  authorize(request: IncomingMessage, response: ServerResponse, url: URL): Promise<ConsoleAuthResult>;
};

export function createDiscordConsoleAuthenticator(
  config: AppConfig["consoleAuth"],
  options: { fetch?: typeof fetch; now?: () => number } = {},
): ConsoleAuthenticator {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const redirectUri = new URL("/auth/callback", config.publicUrl).toString();

  return {
    async authorize(request, response, url) {
      if (url.pathname === "/auth/login") {
        const state = randomBytes(24).toString("base64url");
        const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
        const stateCookie = signPayload({
          expiresAt: now() + STATE_TTL_MS,
          guildId: config.guildId,
          nonce: state,
          returnTo,
        }, config.sessionSecret);
        const destination = new URL("https://discord.com/oauth2/authorize");
        destination.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "identify guilds",
          state,
        }).toString();
        redirect(response, destination.toString(), cookie(STATE_COOKIE, stateCookie, STATE_TTL_MS));
        return "handled";
      }

      if (url.pathname === "/auth/callback") {
        const statePayload = verifyPayload(cookieValue(request, STATE_COOKIE), config.sessionSecret, now());
        const code = url.searchParams.get("code")?.trim();
        const state = url.searchParams.get("state")?.trim();
        if (!code || !state || !statePayload?.nonce || !safeEqual(state, statePayload.nonce)) {
          authError(response, 400, "Discord sign-in could not be verified. Please try again.");
          return "handled";
        }
        const token = await exchangeDiscordCode(fetchImpl, {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          code,
          redirectUri,
        });
        if (!token) {
          authError(response, 502, "Discord sign-in is temporarily unavailable.");
          return "handled";
        }
        const [user, guilds] = await Promise.all([
          discordJson(fetchImpl, `${DISCORD_API}/users/@me`, token),
          discordJson(fetchImpl, `${DISCORD_API}/users/@me/guilds?limit=200`, token),
        ]);
        const userId = recordString(user, "id");
        const isMember = Array.isArray(guilds) && guilds.some((guild) => recordString(guild, "id") === config.guildId);
        if (!userId || !isMember) {
          authError(response, 403, "This Console is available only to members of the configured Discord server.");
          return "handled";
        }
        const session = signPayload({
          expiresAt: now() + SESSION_TTL_MS,
          guildId: config.guildId,
          userId,
        }, config.sessionSecret);
        redirect(response, safeReturnPath(statePayload.returnTo), [
          cookie(SESSION_COOKIE, session, SESSION_TTL_MS),
          expiredCookie(STATE_COOKIE),
        ]);
        return "handled";
      }

      if (url.pathname === "/auth/logout") {
        redirect(response, "/auth/login", expiredCookie(SESSION_COOKIE));
        return "handled";
      }

      const session = verifyPayload(cookieValue(request, SESSION_COOKIE), config.sessionSecret, now());
      return session?.userId && session.guildId === config.guildId ? "authorized" : "unauthorized";
    },
  };
}

async function exchangeDiscordCode(
  fetchImpl: typeof fetch,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
) {
  const response = await fetchImpl(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8_000),
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null);
  return recordString(payload, "access_token");
}

async function discordJson(fetchImpl: typeof fetch, url: string, token: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  return response?.ok ? response.json().catch(() => null) : null;
}

function signPayload(payload: SignedPayload, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body, secret)}`;
}

function verifyPayload(value: string | null, secret: string, now: number): SignedPayload | null {
  if (!value) return null;
  const [body, suppliedSignature, extra] = value.split(".");
  if (!body || !suppliedSignature || extra || !safeEqual(suppliedSignature, signature(body, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedPayload;
    return Number.isFinite(payload.expiresAt) && payload.expiresAt > now ? payload : null;
  } catch {
    return null;
  }
}

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cookieValue(request: IncomingMessage, name: string) {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function cookie(name: string, value: string, ttlMs: number) {
  return `${name}=${value}; Path=/; Max-Age=${Math.floor(ttlMs / 1_000)}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookie(name: string) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function safeReturnPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.length > 2_048 || value.startsWith("//") || value.startsWith("/auth/")) return "/";
  return value;
}

function redirect(response: ServerResponse, location: string, setCookie?: string | string[]) {
  response.writeHead(302, {
    ...authHeaders(),
    Location: location,
    ...(setCookie ? { "Set-Cookie": setCookie } : {}),
    "Content-Length": 0,
  });
  response.end();
}

function authError(response: ServerResponse, status: number, message: string) {
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><title>Console access</title><body style="margin:0;background:#0b0d0a;color:#eef1ea;font:16px/1.5 system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.5rem">Console access</h1><p>${message}</p><a style="color:#b6da6b" href="/auth/login">Try Discord sign-in again</a></main></body></html>`;
  response.writeHead(status, { ...authHeaders(), "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function authHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  } as const;
}

function recordString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate ? candidate : null;
}
