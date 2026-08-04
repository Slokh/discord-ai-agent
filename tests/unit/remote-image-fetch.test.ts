import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, fetchPublicImage, isPublicAddress } from "../../src/tools/remoteImageFetch.js";

describe("public image fetch", () => {
  it("rejects private, loopback, metadata, and non-routable addresses", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    await expect(assertPublicHttpUrl(new URL("http://127.0.0.1/image.png"))).rejects.toThrow(/private|non-routable/);
  });

  it("validates every redirect target before following it", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    };
    await expect(fetchPublicImage("https://example.com/avatar.png", { maxBytes: 1024, fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/private|non-routable/);
    expect(calls).toHaveLength(1);
  });

  it("stops reading when a response exceeds the byte limit", async () => {
    const fetchImpl = async () => new Response(new Uint8Array(20), { headers: { "content-type": "image/png" } });
    await expect(fetchPublicImage("https://example.com/avatar.png", { maxBytes: 10, fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/exceeds/);
  });
});
