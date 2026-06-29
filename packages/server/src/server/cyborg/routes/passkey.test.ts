import { describe, it, expect } from "vitest";
import { createPasskeyRoutes } from "./passkey.js";
import type { PgSync } from "../db/pg-sync.js";

// These drive the REAL Hono app from createPasskeyRoutes with a typed-fake pg.
// The /options endpoints run the real @simplewebauthn generators (no secrets
// needed). The crypto-verify happy paths require a real authenticator and are
// covered by manual / virtual-authenticator E2E; here we pin the security +
// plumbing gates that DON'T need an authenticator: RP-origin requirement,
// single-use challenge, unknown-credential rejection, and bearer auth-gating.

const ORIGIN = "https://app.example.com";

interface FakeOpts {
  // token string -> claims (drives validateUserToken / requireUser)
  tokens?: Record<string, { email: string; name?: string }>;
  users?: Record<string, { id: string; email: string; name: string | null }>;
  challenges?: Record<string, string | null>; // key -> challenge (null = expired/unknown)
  credentials?: Record<string, { userId: string } | undefined>; // credentialId -> stored
  deleteResult?: boolean;
}

function makeApp(opts: FakeOpts = {}) {
  const putCalls: { key: string; purpose: string }[] = [];
  const pg = {
    async putWebauthnChallenge(p: { key: string; purpose: string }) {
      putCalls.push({ key: p.key, purpose: p.purpose });
    },
    async consumeWebauthnChallenge(key: string) {
      return opts.challenges?.[key] ?? null;
    },
    async getWebauthnCredentialsByUser() {
      return [];
    },
    async getWebauthnCredentialByCredentialId(credentialId: string) {
      return opts.credentials?.[credentialId] ?? null;
    },
    async deleteWebauthnCredential() {
      return opts.deleteResult ?? false;
    },
    async getUserByEmail(email: string) {
      return Object.values(opts.users ?? {}).find((u) => u.email === email) ?? null;
    },
    async getUserById(id: string) {
      return opts.users?.[id] ?? null;
    },
  } as unknown as PgSync;

  const app = createPasskeyRoutes({
    pg,
    createUserToken: (email) => `token-for-${email}`,
    validateUserToken: (token) => opts.tokens?.[token] ?? null,
    broadcastToGuests: () => {},
  });
  return { app, putCalls };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("passkey auth/options", () => {
  it("returns options + a challengeKey and stores an 'authenticate' challenge", async () => {
    const { app, putCalls } = makeApp();
    const res = await app.request(post("/api/auth/passkey/auth/options", {}));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { options: { challenge: string }; challengeKey: string };
    expect(json.challengeKey).toBeTruthy();
    expect(json.options.challenge).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].purpose).toBe("authenticate");
    expect(putCalls[0].key).toBe(json.challengeKey);
  });

  it("400s without an Origin header (RP id cannot be derived)", async () => {
    const { app } = makeApp();
    const req = new Request("http://localhost/api/auth/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await app.request(req);
    expect(res.status).toBe(400);
  });
});

describe("passkey auth/verify", () => {
  it("400s when challengeKey/response missing", async () => {
    const { app } = makeApp();
    const res = await app.request(post("/api/auth/passkey/auth/verify", { challengeKey: "k" }));
    expect(res.status).toBe(400);
  });

  it("400s when the challenge is unknown/expired (single-use already consumed)", async () => {
    const { app } = makeApp({ challenges: { k: null } });
    const res = await app.request(
      post("/api/auth/passkey/auth/verify", { challengeKey: "k", response: { id: "cred1" } }),
    );
    expect(res.status).toBe(400);
  });

  it("401s when the asserted credential is unknown", async () => {
    const { app } = makeApp({ challenges: { k: "chal" }, credentials: {} });
    const res = await app.request(
      post("/api/auth/passkey/auth/verify", { challengeKey: "k", response: { id: "ghost" } }),
    );
    expect(res.status).toBe(401);
  });
});

describe("passkey register (authenticated)", () => {
  const user = { id: "u1", email: "seb@example.com", name: "Seb" };

  it("401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request(post("/api/auth/passkey/register/options", {}));
    expect(res.status).toBe(401);
  });

  it("returns creation options + stores a 'register' challenge keyed by user", async () => {
    const { app, putCalls } = makeApp({
      tokens: { good: { email: user.email } },
      users: { [user.id]: user },
    });
    const res = await app.request(
      post("/api/auth/passkey/register/options", {}, { authorization: "Bearer good" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string; rp: { id: string } };
    expect(json.challenge).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].purpose).toBe("register");
    expect(putCalls[0].key).toBe(`reg:${user.id}`);
  });

  it("register/verify 401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request(post("/api/auth/passkey/register/verify", { response: {} }));
    expect(res.status).toBe(401);
  });
});

describe("passkey management auth-gating", () => {
  it("list 401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request(
      new Request("http://localhost/api/auth/passkey/list", { headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(401);
  });

  it("delete 404s for a credential the user does not own", async () => {
    const { app } = makeApp({
      tokens: { good: { email: "seb@example.com" } },
      users: { u1: { id: "u1", email: "seb@example.com", name: null } },
      deleteResult: false,
    });
    const res = await app.request(
      new Request("http://localhost/api/auth/passkey/does-not-exist", {
        method: "DELETE",
        headers: { authorization: "Bearer good", origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(404);
  });
});
