import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedHost,
  isPrivateAddress,
  readBodyCapped,
  secureFetch,
  SsrfBlockedError,
} from "./secure-fetch.js";

// secureFetch resolves each host before fetching (DNS-rebind defense). The tests
// stub node:dns/promises so a placeholder hostname resolves to whatever address
// the case needs (public to allow, private to block). The literal-IP / scheme
// cases short-circuit in the guard BEFORE any DNS lookup, so they're unaffected.
const lookupMock = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...(args as [])),
}));

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

describe("isPrivateAddress", () => {
  it("flags reserved/private/loopback/link-local/CGNAT/multicast literals", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true); // loopback
    expect(isPrivateAddress("10.1.2.3")).toBe(true); // RFC1918
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateAddress("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateAddress("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true); // IPv6 loopback
    expect(isPrivateAddress("fd00::1")).toBe(true); // ULA
    expect(isPrivateAddress("fe80::1")).toBe(true); // link-local
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true); // mapped v4
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("treats a non-IP string as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("isBlockedHost", () => {
  it("blocks well-known internal names and private IP literals", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("foo.local")).toBe(true);
    expect(isBlockedHost("svc.internal")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("[::1]")).toBe(true); // bracketed IPv6 literal
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("")).toBe(true);
  });

  it("allows public hostnames and public IP literals", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });
});

describe("secureFetch — scheme + literal guard", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("rejects a non-https scheme by default without fetching", async () => {
    await expect(secureFetch("http://example.com/x")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(secureFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http when allowHttp is set", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await secureFetch("http://example.com/x", { allowHttp: true });
    expect(res.status).toBe(200);
  });

  it("rejects a private IP literal target before fetching", async () => {
    await expect(secureFetch("https://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("secureFetch — DNS-rebind defense", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    lookupMock.mockReset();
  });

  it("rejects a PUBLIC hostname that resolves to a private IP (rebinding)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(secureFetch("https://rebind.attacker.example/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when ANY resolved address is private (mixed A records)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(secureFetch("https://mixed.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("proceeds when every resolved address is public", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await secureFetch("https://public.example/");
    expect(res.status).toBe(200);
  });
});

describe("secureFetch — redirects", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("throws on a 3xx by default (followRedirects:false) without following", async () => {
    fetchMock.mockResolvedValue(redirect(302, "https://elsewhere.example/x"));
    await expect(secureFetch("https://start.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the redirect target was NOT fetched
  });

  it("refuses a redirect to the cloud-metadata IP even when following", async () => {
    fetchMock.mockResolvedValue(redirect(302, "http://169.254.169.254/latest/meta-data/iam/"));
    await expect(
      secureFetch("https://attacker.example/", { followRedirects: true, allowHttp: true }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // refused before following
  });

  it("follows a redirect to a public host when followRedirects is set", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(302, "https://final.example/page"))
      .mockResolvedValueOnce(new Response("body", { status: 200 }));
    const res = await secureFetch("https://start.example/", { followRedirects: true });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bails after maxRedirects", async () => {
    fetchMock.mockResolvedValue(redirect(302, "https://loop.example/again"));
    await expect(
      secureFetch("https://loop.example/", { followRedirects: true, maxRedirects: 3 }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // hops 0..3, then bail
  });
});

describe("secureFetch — byte cap + timeout", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("rejects when the declared content-length exceeds maxBytes", async () => {
    fetchMock.mockResolvedValue(
      new Response("x", { status: 200, headers: { "content-length": "999999" } }),
    );
    await expect(secureFetch("https://big.example/", { maxBytes: 1000 })).rejects.toThrow(
      /size cap/,
    );
  });

  it("aborts on the wall-clock timeout", async () => {
    // fetch that respects the abort signal and rejects when aborted.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        init.signal?.addEventListener("abort", onAbort);
      });
    });
    await expect(secureFetch("https://slow.example/", { timeoutMs: 20 })).rejects.toThrow();
  });
});

describe("readBodyCapped", () => {
  it("returns the full body when under the cap", async () => {
    const res = new Response("hello world", { status: 200 });
    const buf = await readBodyCapped(res, 1000);
    expect(buf.toString("utf-8")).toBe("hello world");
  });

  it("throws when the streamed body exceeds the cap", async () => {
    const big = "a".repeat(5000);
    const res = new Response(big, { status: 200 });
    await expect(readBodyCapped(res, 100)).rejects.toThrow(/size cap/);
  });
});
