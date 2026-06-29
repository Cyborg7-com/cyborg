import { describe, it, expect, vi, afterEach } from "vitest";
import { isBlockedHost, ssrfSafeFetch } from "./unfurl.js";

// ssrfSafeFetch now resolves each host (DNS-rebind defense, #598) before
// fetching. These redirect-follow tests use placeholder public hostnames that
// don't resolve in CI, so stub the resolver to return a benign PUBLIC address;
// the SSRF-block tests below still target IP LITERALS, which isBlockedHost
// rejects BEFORE any DNS lookup, so they're unaffected by this stub.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

describe("isBlockedHost", () => {
  it("blocks metadata / private / loopback / link-local hosts", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true); // cloud metadata
    expect(isBlockedHost("127.0.0.1")).toBe(true); // loopback
    expect(isBlockedHost("10.0.0.1")).toBe(true); // RFC1918
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true); // IPv6 loopback
    expect(isBlockedHost("localhost")).toBe(true);
  });

  it("allows ordinary public hostnames", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });
});

describe("ssrfSafeFetch — per-hop redirect validation", () => {
  afterEach(() => vi.restoreAllMocks());

  function redirectResponse(status: number, location: string): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("refuses a redirect to the cloud-metadata IP (the SSRF the guard missed)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        redirectResponse(302, "http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await ssrfSafeFetch("https://attacker.example/x", {});
    expect(res).toBeNull();
    // Only the first hop was fetched — the redirect target was NOT followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a private RFC1918 IP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse(301, "http://10.0.0.5/admin"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await ssrfSafeFetch("https://ok.example/", {})).toBeNull();
  });

  it("resolves and re-checks a RELATIVE redirect against the current host", async () => {
    // attacker public host → relative Location that stays on the public host is fine.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(302, "/elsewhere"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await ssrfSafeFetch("https://public.example/start", {});
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://public.example/elsewhere",
      expect.anything(),
    );
  });

  it("follows a redirect to another public host and returns the final response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(302, "https://final.example/page"))
      .mockResolvedValueOnce(new Response("body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await ssrfSafeFetch("https://start.example/", {});
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-http(s) initial URL without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ssrfSafeFetch("file:///etc/passwd", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bails out after too many redirects", async () => {
    // Always redirect (to a public host) → exceeds MAX_REDIRECTS → null.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redirectResponse(302, "https://public.example/loop"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await ssrfSafeFetch("https://public.example/start", {})).toBeNull();
  });
});
