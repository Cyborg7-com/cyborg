import { describe, it, expect } from "vitest";
import { parseProviderModel } from "./pg-sync.js";

// The workspace slash model is stored as a "provider/model" string. Model ids can
// themselves contain slashes (Pi runs backends like "opencode-go/glm-5.1"), so the
// split MUST keep only the FIRST "/" as the provider boundary — otherwise the UI
// run-target hint shows "OpenCode / opencode-go/glm-5.1" for a Pi selection.
describe("parseProviderModel", () => {
  it("keeps provider=pi for pi/<backend>/<model> (the reported bug)", () => {
    expect(parseProviderModel("pi/opencode-go/glm-5.1")).toEqual({
      provider: "pi",
      model: "opencode-go/glm-5.1",
    });
  });

  it("parses a plain provider/model", () => {
    expect(parseProviderModel("claude/claude-haiku-4-5")).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
    });
  });

  it("keeps a model id that contains multiple slashes intact", () => {
    expect(parseProviderModel("opencode/openrouter/google/gemini-2.5-flash")).toEqual({
      provider: "opencode",
      model: "openrouter/google/gemini-2.5-flash",
    });
  });

  it("returns null for blank / null / no-slash / edge inputs", () => {
    expect(parseProviderModel(null)).toBeNull();
    expect(parseProviderModel("")).toBeNull();
    expect(parseProviderModel("pi")).toBeNull(); // no slash
    expect(parseProviderModel("/glm-5.1")).toBeNull(); // empty provider
    expect(parseProviderModel("pi/")).toBeNull(); // empty model
  });
});
