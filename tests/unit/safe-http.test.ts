import { describe, expect, it, vi } from "vitest";
import { isPrivateAddress, safeFetch } from "../../src/payments/safeHttp.js";

describe("MPP safe HTTP", () => {
  it("recognizes private and reserved IPv4 and IPv6 ranges", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "192.168.1.1", "::1", "fd00::1", "2001:db8::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("preserves Request headers and rejects redirects outside the inspected origin", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.headers.get("x-test")).toBe("yes");
      return new Response(null, { status: 302, headers: { location: "https://8.8.8.8/private" } });
    }) as unknown as typeof fetch;
    const request = new Request("https://1.1.1.1/start", { headers: { "x-test": "yes" } });
    await expect(safeFetch(request, {}, { fetchImpl })).rejects.toThrow(/outside its inspected origin/);
  });

  it("refuses redirected non-idempotent request bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/other" } })) as unknown as typeof fetch;
    await expect(
      safeFetch("https://1.1.1.1/start", { method: "POST", body: "payload" }, { fetchImpl })
    ).rejects.toThrow(/cannot redirect a request with a body/);
  });
});
