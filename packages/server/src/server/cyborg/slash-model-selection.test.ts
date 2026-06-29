import { describe, it, expect } from "vitest";
import { parseSlashModel, resolveSlashModelSelection } from "./slash-model-selection.js";

const CHANNEL = JSON.stringify({ provider: "claude", model: "claude-haiku-4-5" });
const ws = { provider: "openai", model: "gpt-5.4-mini" };

describe("parseSlashModel", () => {
  it("parses a valid {provider,model} JSON string", () => {
    expect(parseSlashModel(CHANNEL)).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });
  it("returns null for empty / corrupt / partial values", () => {
    expect(parseSlashModel(null)).toBeNull();
    expect(parseSlashModel(undefined)).toBeNull();
    expect(parseSlashModel("not json")).toBeNull();
    expect(parseSlashModel(JSON.stringify({ provider: "claude" }))).toBeNull();
  });
});

describe("resolveSlashModelSelection — precedence channel > workspace > auto", () => {
  // ── Cloud (PG-blind) — the bug: the per-channel override lives only in PG and is
  // forwarded by the relay on resolvedChannel. It must WIN over the workspace default.
  it("cloud: resolvedChannel override beats the forwarded workspace default", () => {
    const r = resolveSlashModelSelection({
      hasPg: false,
      resolvedChannelModel: CHANNEL,
      forwardedWorkspaceModel: ws,
    });
    expect(r.source).toBe("channel");
    expect(r.selection).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });

  it("cloud: resolvedChannel override beats the LOCAL channel row", () => {
    const localStale = JSON.stringify({ provider: "codex", model: "o4" });
    const r = resolveSlashModelSelection({
      hasPg: false,
      resolvedChannelModel: CHANNEL, // relay-forwarded (authoritative)
      localChannelModel: localStale, // stale local SQLite row
      forwardedWorkspaceModel: ws,
    });
    expect(r.selection).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });

  it("cloud: falls back to the workspace default when there is no channel override", () => {
    const r = resolveSlashModelSelection({
      hasPg: false,
      resolvedChannelModel: null,
      localChannelModel: null,
      forwardedWorkspaceModel: ws,
    });
    expect(r.source).toBe("workspace");
    expect(r.selection).toEqual(ws);
  });

  it("cloud: auto-resolves when neither channel nor workspace is set", () => {
    const r = resolveSlashModelSelection({ hasPg: false });
    expect(r.source).toBe("auto");
    expect(r.selection).toBeNull();
  });

  it("cloud: falls back to the local channel row in solo/no-relay (no resolvedChannel)", () => {
    const r = resolveSlashModelSelection({
      hasPg: false,
      resolvedChannelModel: undefined, // no relay enrichment
      localChannelModel: CHANNEL,
    });
    expect(r.source).toBe("channel");
    expect(r.selection).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });

  // ── PG-connected daemon ──
  it("pg: channel override beats the workspace default", () => {
    const r = resolveSlashModelSelection({
      hasPg: true,
      pgChannelModel: CHANNEL,
      pgWorkspaceModel: ws,
    });
    expect(r.source).toBe("channel");
    expect(r.selection).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });

  it("pg: a corrupt channel value degrades to the workspace default", () => {
    const r = resolveSlashModelSelection({
      hasPg: true,
      pgChannelModel: "not-json",
      pgWorkspaceModel: ws,
    });
    expect(r.source).toBe("workspace");
    expect(r.selection).toEqual(ws);
  });
});
