import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClientErrorPayload, reportClientError } from "./client-error.js";
import { resolveRelayBase } from "./relay-url.js";

describe("buildClientErrorPayload — shaping + clamping", () => {
  it("clamps message to 4000 and stack to 12000 chars", () => {
    const payload = buildClientErrorPayload({
      source: "react-error-boundary",
      message: "m".repeat(5000),
      stack: "s".repeat(20000),
    });
    expect(payload.message.length).toBe(4000);
    expect(payload.stack?.length).toBe(12000);
  });

  it("defaults source to 'client' and stack to null", () => {
    const payload = buildClientErrorPayload({ source: "", message: "x" });
    expect(payload.source).toBe("client");
    expect(payload.stack).toBeNull();
  });

  it("passes through extra context fields (platform/version/workspaceId/custom)", () => {
    const payload = buildClientErrorPayload({
      source: "window.onerror",
      message: "boom",
      platform: "desktop",
      version: "1.4.0",
      workspaceId: "ws_1",
      pathname: "/client/ws_1",
    });
    expect(payload.platform).toBe("desktop");
    expect(payload.version).toBe("1.4.0");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.pathname).toBe("/client/ws_1");
  });

  it("handles a null/undefined message without throwing", () => {
    const payload = buildClientErrorPayload({
      source: "x",
      message: undefined as unknown as string,
    });
    expect(payload.message).toBe("Unknown client error");
  });
});

class FakeBlob {
  parts: unknown[];
  constructor(parts: unknown[]) {
    this.parts = parts;
  }
}

describe("resolveRelayBase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the canonical cloud relay http origin when no session/window", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("window", undefined);
    expect(resolveRelayBase()).toBe("https://relay.cyborg7.com");
  });

  it("derives the http origin from the saved-session ws url", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ url: "wss://relay.example.com/api/ws", token: "t" }),
    });
    expect(resolveRelayBase()).toBe("https://relay.example.com");
  });

  it("returns '' (relative) when the relay is the same origin as the page", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ url: "wss://app.local/api/ws", token: "t" }),
    });
    vi.stubGlobal("window", { location: { origin: "https://app.local" } });
    expect(resolveRelayBase()).toBe("");
  });
});

describe("reportClientError — beacon + console", () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("always console.errors and sends a beacon to /api/cyborg/client-log", () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    reportClientError({ source: "test", message: "boom", stack: "stack" });
    expect(consoleErr).toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe("https://relay.cyborg7.com/api/cyborg/client-log");
    const body = JSON.parse((blob as FakeBlob).parts[0] as string);
    expect(body.message).toBe("boom");
    expect(body.source).toBe("test");
  });

  it("beacons to the relay even inside the Electron desktop shell (no IPC path)", () => {
    // A `window.cyborg7Desktop` bridge used to short-circuit reportClientError to
    // IPC → a no-op main-process sink. That branch is gone: the desktop renderer
    // beacons the relay exactly like web/mobile. Stub the bridge to prove it is
    // ignored and the relay beacon still fires.
    const reportErrorBridge = vi.fn();
    vi.stubGlobal("window", {
      location: { origin: "https://app.example.com" },
      cyborg7Desktop: { reportError: reportErrorBridge },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportClientError({ source: "desktop-renderer", message: "boom", platform: "desktop" });
    expect(reportErrorBridge).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url] = beacon.mock.calls[0];
    expect(url).toBe("https://relay.cyborg7.com/api/cyborg/client-log");
  });

  it("falls back to keepalive fetch when sendBeacon is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    const fetchMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportClientError({ source: "test", message: "boom" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
  });

  it("never throws even if everything is missing", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("fetch", undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportClientError({ source: "test", message: "boom" })).not.toThrow();
  });
});
