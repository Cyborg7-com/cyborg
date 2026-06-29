import { describe, it, expect } from "vitest";
import { buildCyboRuntimeProfile, profileFromModelIds } from "./cybo-runtime-profile.js";

describe("profileFromModelIds", () => {
  it("groups model ids by backend prefix with counts", () => {
    const p = profileFromModelIds([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "opencode-go/glm-5.1",
      "openai/gpt-5",
    ]);
    expect(p.configured).toBe(true);
    expect(p.modelCount).toBe(4);
    expect(p.backends).toEqual([
      { backend: "anthropic", modelCount: 2 },
      { backend: "openai", modelCount: 1 },
      { backend: "opencode-go", modelCount: 1 },
    ]);
  });

  it("zero models → unconfigured (the GAP-5 'installed but no auth' shape)", () => {
    expect(profileFromModelIds([])).toEqual({
      configured: false,
      modelCount: 0,
      backends: [],
    });
  });

  it("ids without a backend prefix degrade to the binary signal (no invented backends)", () => {
    const p = profileFromModelIds(["glm-5.1", "some-model"]);
    expect(p.configured).toBe(true);
    expect(p.modelCount).toBe(2);
    expect(p.backends).toEqual([]);
  });

  it("ignores a leading slash (malformed id) rather than inventing an empty backend", () => {
    expect(profileFromModelIds(["/weird"]).backends).toEqual([]);
  });
});

describe("buildCyboRuntimeProfile", () => {
  const manager = (entry: unknown) =>
    ({
      listProviders: async () => (entry ? [entry] : []),
    }) as never;

  it("null manager / no pi entry / still-loading → null (omit, don't publish a lie)", async () => {
    expect(await buildCyboRuntimeProfile(null)).toBeNull();
    expect(await buildCyboRuntimeProfile(manager(null))).toBeNull();
    expect(
      await buildCyboRuntimeProfile(manager({ provider: "pi", status: "loading" })),
    ).toBeNull();
  });

  it("ready pi with models → per-backend profile", async () => {
    const profile = await buildCyboRuntimeProfile(
      manager({
        provider: "pi",
        status: "ready",
        models: [{ id: "anthropic/claude-haiku-4-5" }, { id: "opencode-go/glm-5.1" }],
      }),
    );
    expect(profile).toEqual({
      configured: true,
      modelCount: 2,
      backends: [
        { backend: "anthropic", modelCount: 1 },
        { backend: "opencode-go", modelCount: 1 },
      ],
    });
  });

  it("unavailable pi (installed without auth) → configured:false even if stale models linger", async () => {
    const profile = await buildCyboRuntimeProfile(
      manager({
        provider: "pi",
        status: "unavailable",
        models: [{ id: "anthropic/stale" }],
      }),
    );
    expect(profile).toEqual({ configured: false, modelCount: 0, backends: [] });
  });

  it("a throwing snapshot read → null (never breaks the heartbeat path)", async () => {
    const boom = { listProviders: async () => Promise.reject(new Error("boom")) } as never;
    expect(await buildCyboRuntimeProfile(boom)).toBeNull();
  });
});
