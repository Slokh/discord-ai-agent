import { describe, expect, it, vi } from "vitest";
import { checkConsoleHealth } from "../../scripts/consoleHealth.js";

const now = Date.parse("2026-08-09T00:00:00.000Z");

describe("production Console health", () => {
  it("can verify the public boundary without attempting the cluster-internal data path", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: "/auth/login?returnTo=%2F" } });
      return json({ error: "authentication_required" }, 401);
    });

    const result = await checkConsoleHealth({
      expectedRevision: "revision-a",
      internalUrl: null,
      publicUrl: "https://console.example.com",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.status).toBe("healthy");
    expect(result.activity).toEqual({ sampled: false, detailSampled: false });
    expect(result.checks.map((check) => check.name)).toEqual([
      "public_health", "public_auth_redirect", "public_api_boundary",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("verifies the public auth boundary and fresh production data path", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.origin === "https://console.example.com" && url.pathname === "/healthz") {
        return json({ ok: true });
      }
      if (url.origin === "https://console.example.com" && url.pathname === "/") {
        return new Response(null, { status: 302, headers: { location: "/auth/login?returnTo=%2F" } });
      }
      if (url.origin === "https://console.example.com" && url.pathname === "/api/overview") {
        return json({ error: "authentication_required" }, 401);
      }
      if (url.pathname === "/api/overview") {
        return json({ schemaVersion: 3, environment: "production", revision: "revision-a", generatedAt: new Date(now).toISOString() });
      }
      if (url.pathname === "/api/activity") {
        return json({ schemaVersion: 3, environment: "production", active: [], recent: [{ kind: "improvement", id: "improvement-a" }] });
      }
      return json({ schemaVersion: 2, environment: "production", kind: "improvement", id: "improvement-a" });
    });

    const result = await checkConsoleHealth({
      expectedRevision: "revision-a",
      internalUrl: "http://127.0.0.1:8081",
      publicUrl: "https://console.example.com",
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    });

    expect(result).toMatchObject({ status: "healthy", revision: "revision-a", activity: { sampled: true, detailSampled: true } });
    expect(result.checks.map((check) => check.name)).toEqual([
      "public_health", "public_auth_redirect", "public_api_boundary",
      "production_overview", "production_activity", "production_activity_detail",
    ]);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("fails closed for an exposed API, stale projection, and wrong revision", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.origin === "https://console.example.com" && url.pathname === "/healthz") return json({ ok: true });
      if (url.origin === "https://console.example.com" && url.pathname === "/") {
        return new Response(null, { status: 302, headers: { location: "/auth/login?returnTo=%2F" } });
      }
      if (url.origin === "https://console.example.com") return json({ schemaVersion: 3 });
      if (url.pathname === "/api/overview") {
        return json({ schemaVersion: 3, environment: "production", revision: "revision-old", generatedAt: "2026-08-08T23:00:00.000Z" });
      }
      return json({ schemaVersion: 3, environment: "production", active: [], recent: [] });
    });

    const result = await checkConsoleHealth({
      expectedRevision: "revision-a",
      internalUrl: "http://127.0.0.1:8081",
      publicUrl: "https://console.example.com",
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "public_api_boundary", status: "failed", code: "api_not_protected" }),
      expect.objectContaining({ name: "production_overview", status: "failed", code: "revision_mismatch" }),
    ]));
    expect(result.activity.detailSampled).toBe(false);
  });

  it("reports request failures without leaking exception details", async () => {
    const result = await checkConsoleHealth({
      expectedRevision: "revision-a",
      internalUrl: "http://127.0.0.1:8081",
      fetchImpl: vi.fn(async () => { throw new Error("private upstream detail"); }) as typeof fetch,
      now: () => now,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.checks).toEqual([
      { name: "production_overview", status: "failed", durationMs: null, code: "request_failed" },
      { name: "production_activity", status: "failed", durationMs: null, code: "request_failed" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private upstream detail");
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
