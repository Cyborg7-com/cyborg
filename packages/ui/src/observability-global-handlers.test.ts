// @vitest-environment jsdom
//
// Behavior tests for the REAL @cyborg7/observability/web runtime as wired into the
// browser shell. These cover the window-event seam NOT exercised by observability's
// own client-error.test.ts (which tests payload shaping + the beacon/keepalive-fetch
// transport in isolation, with no window/event wiring):
//
//   1. installGlobalErrorHandlers() — window "error" + "unhandledrejection" events
//      actually reach the reporter, and the installer is idempotent.
//   2. The desktop renderer beacons to the relay just like web/mobile: there is NO
//      Electron-IPC bridge anymore. A window.cyborg7Desktop bridge (if present) is
//      ignored by the reporter; the relay beacon always fires.
//
// We import the real module (no vi.mock) and assert the observable delivery side
// effects (sendBeacon / console.error), then reset modules per test so the
// module-level install guard starts fresh. Window listeners registered by the
// installer are captured via an addEventListener spy and removed in afterEach so a
// previous test's handler can't fire (and double-count) in a later test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WebModule = typeof import("@cyborg7/observability/web");

let beacon: ReturnType<typeof vi.fn>;
let consoleErr: ReturnType<typeof vi.spyOn>;
// Captured (type, listener) pairs registered on window so we can tear them down.
let registered: Array<[string, EventListenerOrEventListenerObject]>;

async function loadFreshModule(): Promise<WebModule> {
  vi.resetModules();
  return import("@cyborg7/observability/web");
}

beforeEach(() => {
  registered = [];
  // jsdom's navigator has no sendBeacon — define one so the reporter takes the
  // beacon path (its preferred transport) and we can assert on it.
  beacon = vi.fn(() => true);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: beacon,
  });
  consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

  // Capture window listeners the installer registers so afterEach can remove them.
  const realAdd = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    registered.push([type, listener]);
    return realAdd(type, listener, opts);
  }) as typeof window.addEventListener);
});

afterEach(() => {
  // Restore any stubbed globals (e.g. a test that nulled `window`) BEFORE touching
  // window below, then drop spies.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (typeof window !== "undefined") {
    for (const [type, listener] of registered) {
      window.removeEventListener(type, listener);
    }
    // Drop any desktop bridge a test installed.
    delete (window as unknown as { cyborg7Desktop?: unknown }).cyborg7Desktop;
  }
});

describe("installGlobalErrorHandlers — window error wiring", () => {
  it("beacons a 'window.onerror'-sourced payload on a window 'error' event", async () => {
    const { installGlobalErrorHandlers } = await loadFreshModule();
    installGlobalErrorHandlers({ platform: "web" });

    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("kaboom"),
        message: "kaboom",
        filename: "app.js",
        lineno: 10,
        colno: 5,
      }),
    );

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toContain("/api/cyborg/client-log");
    const body = JSON.parse(await blob.text());
    expect(body.source).toBe("window.onerror");
    expect(body.message).toBe("kaboom");
    expect(body.platform).toBe("web");
    expect(consoleErr).toHaveBeenCalled();
  });

  it("beacons an 'unhandledrejection'-sourced payload on a rejection event", async () => {
    const { installGlobalErrorHandlers } = await loadFreshModule();
    installGlobalErrorHandlers({ platform: "web" });

    const reason = new Error("promise died");
    const evt = new Event("unhandledrejection") as PromiseRejectionEvent;
    // jsdom's PromiseRejectionEvent ctor requires a live promise; attach the fields
    // the handler reads directly instead (it only reads event.reason).
    Object.defineProperty(evt, "reason", { value: reason, configurable: true });
    window.dispatchEvent(evt);

    expect(beacon).toHaveBeenCalledTimes(1);
    const [, blob] = beacon.mock.calls[0] as [string, Blob];
    const body = JSON.parse(await blob.text());
    expect(body.source).toBe("unhandledrejection");
    expect(body.message).toBe("promise died");
  });

  it("is idempotent: a second install does not double-register (one event → one beacon)", async () => {
    const { installGlobalErrorHandlers } = await loadFreshModule();
    installGlobalErrorHandlers({ platform: "web" });
    installGlobalErrorHandlers({ platform: "web" }); // guarded no-op

    // The installer's two addEventListener calls happen only on the FIRST install.
    const errorRegs = registered.filter(([t]) => t === "error");
    const rejRegs = registered.filter(([t]) => t === "unhandledrejection");
    expect(errorRegs).toHaveLength(1);
    expect(rejRegs).toHaveLength(1);

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("once"), message: "once" }));
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it("no-ops without throwing when there is no window (SSR / non-browser host)", async () => {
    const mod = await loadFreshModule();
    vi.stubGlobal("window", undefined);
    expect(() => mod.installGlobalErrorHandlers({ platform: "web" })).not.toThrow();
  });
});

describe("reportClientError — always beacons the relay (no Electron-IPC path)", () => {
  it("beacons to the relay even when a window.cyborg7Desktop.reportError bridge is present", async () => {
    // The old IPC bridge is gone — the desktop renderer beacons like web/mobile.
    // A stale/foreign bridge must NOT divert the report away from the relay.
    const ipc = vi.fn();
    (window as unknown as { cyborg7Desktop: { reportError: typeof ipc } }).cyborg7Desktop = {
      reportError: ipc,
    };

    const { reportClientError } = await loadFreshModule();
    reportClientError({ source: "test-desktop", message: "boom", platform: "desktop" });

    expect(ipc).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toContain("/api/cyborg/client-log");
    const body = JSON.parse(await blob.text());
    expect(body.source).toBe("test-desktop");
    expect(body.message).toBe("boom");
    expect(body.platform).toBe("desktop");
  });

  it("beacons the relay when no desktop bridge is present (web/mobile)", async () => {
    // No window.cyborg7Desktop set in this test.
    const { reportClientError } = await loadFreshModule();
    reportClientError({ source: "test-web", message: "boom" });

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url] = beacon.mock.calls[0] as [string];
    expect(url).toContain("/api/cyborg/client-log");
  });

  it("installGlobalErrorHandlers beacons the relay on the desktop platform too", async () => {
    const ipc = vi.fn();
    (window as unknown as { cyborg7Desktop: { reportError: typeof ipc } }).cyborg7Desktop = {
      reportError: ipc,
    };

    const { installGlobalErrorHandlers } = await loadFreshModule();
    installGlobalErrorHandlers({ platform: "desktop" });

    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("native"), message: "native" }),
    );

    expect(ipc).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toContain("/api/cyborg/client-log");
    const body = JSON.parse(await blob.text());
    expect(body.source).toBe("window.onerror");
    expect(body.platform).toBe("desktop");
  });
});
