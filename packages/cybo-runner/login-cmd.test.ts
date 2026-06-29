import { describe, expect, it } from "vitest";
import {
  loadRuntimeAuth,
  runLogin,
  runLogout,
  type LoginIo,
  type RuntimeAuth,
  type RuntimeLoginCallbacks,
} from "./login-cmd.js";

// Scripted terminal: answers come from the queue, every printed line and
// question is captured for assertions (including the branding rule).
function fakeIo(answers: string[]): LoginIo & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    print: (line) => output.push(line),
    question: async (query) => {
      output.push(query);
      return answers.shift() ?? "";
    },
    openUrl: (url) => output.push(`[open] ${url}`),
  };
}

function fakeAuth(initial: Record<string, { type: string }> = {}) {
  const store: Record<string, { type: string }> = { ...initial };
  const calls: string[] = [];
  const auth: RuntimeAuth & { calls: string[]; store: typeof store } = {
    calls,
    store,
    getOAuthProviders: () => [
      { id: "anthropic-oauth", name: "Anthropic (Claude Pro/Max)" },
      { id: "openai-codex", name: "OpenAI (ChatGPT/Codex)" },
    ],
    login: async (id, callbacks: RuntimeLoginCallbacks) => {
      calls.push(`login:${id}`);
      // Exercise the callback wiring like the runtime's real flow does.
      callbacks.onAuth({ url: "https://example.com/authorize" });
      store[id] = { type: "oauth" };
    },
    set: (id, cred) => {
      calls.push(`set:${id}:${cred.type}`);
      store[id] = cred;
    },
    remove: (id) => {
      calls.push(`remove:${id}`);
      delete store[id];
    },
    getAll: () => ({ ...store }),
  };
  return auth;
}

describe("cybo login", () => {
  it("picker lists the runtime's OAuth providers + API key, drives the chosen login", async () => {
    const auth = fakeAuth();
    const io = fakeIo(["1"]); // pick the first provider
    const code = await runLogin({ auth, io });
    expect(code).toBe(0);
    expect(auth.calls).toEqual(["login:anthropic-oauth"]);
    const joined = io.output.join("\n");
    expect(joined).toContain("Anthropic (Claude Pro/Max)");
    expect(joined).toContain("OpenAI (ChatGPT/Codex)");
    expect(joined).toContain("API key");
    expect(joined).toContain("[open] https://example.com/authorize"); // onAuth wired
    expect(joined).toContain("connected");
  });

  it("explicit provider arg skips the picker (cybo login <provider>)", async () => {
    const auth = fakeAuth();
    const io = fakeIo([]);
    const code = await runLogin({ provider: "openai-codex", auth, io });
    expect(code).toBe(0);
    expect(auth.calls).toEqual(["login:openai-codex"]);
    expect(io.output.join("\n")).not.toContain("Choose [");
  });

  it("announces detected host logins before the picker (valid only)", async () => {
    const auth = fakeAuth();
    const io = fakeIo(["1"]);
    const code = await runLogin({
      auth,
      io,
      detect: () => [
        { found: true, backend: "anthropic", source: "claude-code-file", valid: true },
        // Expired → must NOT be announced.
        { found: true, backend: "openai", source: "codex-cli", valid: false },
      ],
    });
    expect(code).toBe(0);
    const joined = io.output.join("\n");
    expect(joined).toContain("Detected logins already on this machine:");
    expect(joined).toContain("Claude");
    expect(joined).not.toContain("ChatGPT/Codex (codex-cli)"); // expired one excluded
  });

  it("says nothing about detection when no host logins exist", async () => {
    const auth = fakeAuth();
    const io = fakeIo(["1"]);
    await runLogin({ auth, io, detect: () => [] });
    expect(io.output.join("\n")).not.toContain("Detected logins");
  });

  it("API key path writes the runtime credential shape", async () => {
    const auth = fakeAuth();
    // pick option 3 (API key), then provider id, then the key
    const io = fakeIo(["3", "opencode-go", "sk-test-123"]);
    const code = await runLogin({ auth, io });
    expect(code).toBe(0);
    expect(auth.calls).toEqual(["set:opencode-go:api_key"]);
    expect(auth.store["opencode-go"]).toEqual({ type: "api_key", key: "sk-test-123" });
  });

  it("unknown explicit provider fails without touching the store", async () => {
    const auth = fakeAuth();
    const code = await runLogin({ provider: "nope", auth, io: fakeIo([]) });
    expect(code).toBe(1);
    expect(auth.calls).toEqual([]);
  });

  it("empty pick aborts cleanly", async () => {
    const auth = fakeAuth();
    const code = await runLogin({ auth, io: fakeIo([""]) });
    expect(code).toBe(1);
    expect(auth.calls).toEqual([]);
  });

  it("BRANDING: cybo-controlled strings never say the runtime's internal name", async () => {
    const auth = fakeAuth();
    const ios = [fakeIo(["1"]), fakeIo(["3", "anthropic", "sk-x"]), fakeIo([""])];
    await runLogin({ auth, io: ios[0] });
    await runLogin({ auth, io: ios[1] });
    await runLogin({ auth, io: ios[2] });
    for (const io of ios) {
      for (const line of io.output) {
        // Provider names come from the runtime registry (not ours); our own copy
        // must say "Cybo runtime" and never the internal name as a word.
        expect(line).not.toMatch(/(^|[^a-z])pi([^a-z]|$)/i);
      }
    }
  });
});

describe("cybo logout", () => {
  it("lists stored credentials and removes the chosen one", async () => {
    const auth = fakeAuth({ "anthropic-oauth": { type: "oauth" }, openai: { type: "api_key" } });
    const io = fakeIo(["2"]);
    const code = await runLogout({ auth, io });
    expect(code).toBe(0);
    expect(auth.calls).toEqual(["remove:openai"]);
    expect(io.output.join("\n")).toContain("Signed out of openai");
  });

  it("explicit provider arg removes directly", async () => {
    const auth = fakeAuth({ "anthropic-oauth": { type: "oauth" } });
    const code = await runLogout({ provider: "anthropic-oauth", auth, io: fakeIo([]) });
    expect(code).toBe(0);
    expect(auth.calls).toEqual(["remove:anthropic-oauth"]);
  });

  it("no stored credentials is a clean no-op", async () => {
    const auth = fakeAuth();
    const io = fakeIo([]);
    expect(await runLogout({ auth, io })).toBe(0);
    expect(io.output.join("\n")).toContain("No stored credentials");
  });

  it("unknown provider doesn't remove anything", async () => {
    const auth = fakeAuth({ openai: { type: "api_key" } });
    expect(await runLogout({ provider: "google", auth, io: fakeIo([]) })).toBe(1);
    expect(auth.store.openai).toBeDefined();
  });
});

describe("loadRuntimeAuth (real bundled runtime)", () => {
  it("loads the runtime's AuthStorage with OAuth providers registered", async () => {
    const auth = await loadRuntimeAuth();
    const providers = auth.getOAuthProviders();
    expect(providers.length).toBeGreaterThan(0);
    // Subscriptions the spec names must be reachable through the runtime.
    const names = providers.map((p) => `${p.id} ${p.name}`.toLowerCase()).join(" | ");
    expect(names).toMatch(/anthropic|claude/);
    expect(names).toMatch(/codex|openai/);
    expect(typeof auth.login).toBe("function");
    expect(typeof auth.remove).toBe("function");
  });
});
