import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickUpAuthHeaderValue, exchangeCode, CLICKUP_OAUTH_TOKEN_URL } from "./clickup-app.js";

// clickUpAuthHeaderValue: a personal pk_ token is sent verbatim; an OAuth access token
// takes the documented `Bearer ` prefix (the docs-verification fix — raw-OAuth was
// unverified against a live token, Bearer is the documented form).
describe("clickUpAuthHeaderValue", () => {
  it("sends a personal pk_ token verbatim", () => {
    expect(clickUpAuthHeaderValue("pk_123_ABC")).toBe("pk_123_ABC");
  });

  it("prefixes an OAuth access token with Bearer", () => {
    expect(clickUpAuthHeaderValue("81234567_deadbeef")).toBe("Bearer 81234567_deadbeef");
  });
});

// exchangeCode posts client_id/client_secret/code as an x-www-form-urlencoded BODY (the
// documented form), NOT query params, and returns { ok, accessToken }.
describe("exchangeCode", () => {
  beforeEach(() => {
    process.env.CLICKUP_OAUTH_CLIENT_ID = "cid";
    process.env.CLICKUP_OAUTH_CLIENT_SECRET = "csecret";
  });
  afterEach(() => {
    delete process.env.CLICKUP_OAUTH_CLIENT_ID;
    delete process.env.CLICKUP_OAUTH_CLIENT_SECRET;
    vi.unstubAllGlobals();
  });

  it("posts a form-urlencoded body (not query params) and returns the token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return { ok: true, json: async () => ({ access_token: "tok_live" }) } as unknown as Response;
      }),
    );

    const res = await exchangeCode("the_code");
    expect(res).toEqual({ ok: true, accessToken: "tok_live" });
    // URL carries NO credentials as query params.
    expect(captured!.url).toBe(CLICKUP_OAUTH_TOKEN_URL);
    expect(captured!.init.method).toBe("POST");
    expect((captured!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // Body is form-urlencoded with all three params.
    const body = captured!.init.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("code")).toBe("the_code");
  });

  it("returns { ok:false } (no throw) when not configured", async () => {
    delete process.env.CLICKUP_OAUTH_CLIENT_ID;
    const res = await exchangeCode("x");
    expect(res.ok).toBe(false);
  });

  it("returns { ok:false } on a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ err: "bad_code" }) }) as unknown as Response),
    );
    const res = await exchangeCode("x");
    expect(res.ok).toBe(false);
  });
});
