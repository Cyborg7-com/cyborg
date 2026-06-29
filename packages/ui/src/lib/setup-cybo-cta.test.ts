import { describe, expect, it } from "vitest";
import { connectProviderLabel, resolveSetupCyboCta, runtimeSupportsLogin } from "./setup-cybo-cta.js";

const ME = "user-1";
const OTHER = "user-2";
const HOST = "Sebastians-MacBook-Pro.local";

function daemon(ownerId: string, host?: string) {
  return { ownerId, meta: host ? { host } : {} };
}

const DESKTOP_LOCAL = {
  hasTerminalBridge: true,
  currentUserId: ME,
  appHostname: HOST,
  cliInstalled: true,
  cliVersion: "0.2.6",
};

describe("resolveSetupCyboCta (internal docs Phase 1 gating)", () => {
  it("own daemon on THIS machine in the desktop app → embedded terminal", () => {
    expect(resolveSetupCyboCta({ ...DESKTOP_LOCAL, daemon: daemon(ME, HOST) })).toEqual({
      kind: "terminal",
    });
  });

  it("someone else's daemon → command, even on the same host", () => {
    expect(resolveSetupCyboCta({ ...DESKTOP_LOCAL, daemon: daemon(OTHER, HOST) })).toEqual({
      kind: "command",
      command: "cybo login",
    });
  });

  it("own daemon on a DIFFERENT machine → command (Phase 2 = remote PTY)", () => {
    expect(
      resolveSetupCyboCta({ ...DESKTOP_LOCAL, daemon: daemon(ME, "Rodrigos-MacBook.local") }),
    ).toEqual({ kind: "command", command: "cybo login" });
  });

  it("plain browser (no pty bridge) → command, even for the local own daemon", () => {
    expect(
      resolveSetupCyboCta({
        ...DESKTOP_LOCAL,
        hasTerminalBridge: false,
        daemon: daemon(ME, HOST),
      }),
    ).toEqual({ kind: "command", command: "cybo login" });
  });

  it("daemon without a published hostname → command (can't prove it's this machine)", () => {
    expect(resolveSetupCyboCta({ ...DESKTOP_LOCAL, daemon: daemon(ME) })).toEqual({
      kind: "command",
      command: "cybo login",
    });
  });

  it("hostname not yet resolved (bridge lookup in flight) → command, no flash of a dead button", () => {
    expect(
      resolveSetupCyboCta({ ...DESKTOP_LOCAL, appHostname: null, daemon: daemon(ME, HOST) }),
    ).toEqual({ kind: "command", command: "cybo login" });
  });

  it("CLI not installed yet → the command includes the install step", () => {
    expect(
      resolveSetupCyboCta({
        ...DESKTOP_LOCAL,
        cliInstalled: false,
        cliVersion: null,
        daemon: daemon(OTHER, "elsewhere"),
      }),
    ).toEqual({ kind: "command", command: "npm i -g @cyborg7/cybo@latest && cybo login" });
  });

  it("no daemon → hidden", () => {
    expect(resolveSetupCyboCta({ ...DESKTOP_LOCAL, daemon: undefined })).toEqual({
      kind: "hidden",
    });
  });
});

// W0's #399 finding: a runtime older than 0.2.6 has no `login` subcommand and
// treats `cybo login` as a one-shot AI PROMPT — the terminal must never spawn
// it there. The gate routes those through the update path first.
describe("runtime version gate (cybo login requires >= 0.2.6)", () => {
  it("runtimeSupportsLogin: boundary + ordering + junk", () => {
    expect(runtimeSupportsLogin("0.2.6")).toBe(true);
    expect(runtimeSupportsLogin("0.2.10")).toBe(true); // numeric, not lexicographic
    expect(runtimeSupportsLogin("0.3.0")).toBe(true);
    expect(runtimeSupportsLogin("1.0.0")).toBe(true);
    expect(runtimeSupportsLogin("v0.2.7")).toBe(true);
    expect(runtimeSupportsLogin("0.2.5")).toBe(false); // today's deployed version
    expect(runtimeSupportsLogin("0.1.9")).toBe(false);
    expect(runtimeSupportsLogin(null)).toBe(false); // unknown = fail safe
    expect(runtimeSupportsLogin(undefined)).toBe(false);
    expect(runtimeSupportsLogin("latest")).toBe(false); // unparseable = fail safe
  });

  it("local own daemon with cybo 0.2.5 → update-first, NOT the terminal", () => {
    expect(
      resolveSetupCyboCta({ ...DESKTOP_LOCAL, cliVersion: "0.2.5", daemon: daemon(ME, HOST) }),
    ).toEqual({ kind: "update-first" });
  });

  it("local own daemon with unknown version → update-first (never spawn blind)", () => {
    expect(
      resolveSetupCyboCta({ ...DESKTOP_LOCAL, cliVersion: null, daemon: daemon(ME, HOST) }),
    ).toEqual({ kind: "update-first" });
  });

  it("after the update bumps the version, the same inputs resolve to the terminal", () => {
    expect(
      resolveSetupCyboCta({ ...DESKTOP_LOCAL, cliVersion: "0.2.6", daemon: daemon(ME, HOST) }),
    ).toEqual({ kind: "terminal" });
  });

  it("remote daemon with an old runtime → the command includes the update step", () => {
    expect(
      resolveSetupCyboCta({
        ...DESKTOP_LOCAL,
        cliVersion: "0.2.5",
        daemon: daemon(ME, "Rodrigos-MacBook.local"),
      }),
    ).toEqual({ kind: "command", command: "npm i -g @cyborg7/cybo@latest && cybo login" });
  });
});

// Always-reachable CTA label (runtime section): the two real-user states.
describe("connectProviderLabel", () => {
  it("ARTIFACT state 1 — no auth at all: 'Set up Cybo'", () => {
    expect(connectProviderLabel({ configured: false, backends: [] })).toEqual({
      label: "Set up Cybo",
      detail: null,
    });
    expect(connectProviderLabel(null)).toEqual({ label: "Set up Cybo", detail: null });
    expect(connectProviderLabel(undefined)).toEqual({ label: "Set up Cybo", detail: null });
  });

  it("ARTIFACT state 2 — opencode-go already authenticated: 'Connect provider · opencode-go connected'", () => {
    expect(
      connectProviderLabel({
        configured: true,
        backends: [{ backend: "opencode-go", modelCount: 2 }],
      }),
    ).toEqual({ label: "Connect provider", detail: "opencode-go connected" });
  });

  it("multiple backends list them all; zero-count backends are filtered", () => {
    expect(
      connectProviderLabel({
        configured: true,
        backends: [
          { backend: "anthropic", modelCount: 3 },
          { backend: "opencode-go", modelCount: 1 },
          { backend: "openai", modelCount: 0 },
        ],
      }),
    ).toEqual({ label: "Connect provider", detail: "anthropic, opencode-go connected" });
  });

  it("configured without a derivable breakdown still reads as Connect provider", () => {
    expect(connectProviderLabel({ configured: true, backends: [] })).toEqual({
      label: "Connect provider",
      detail: "a provider is connected",
    });
  });
});
