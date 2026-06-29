// @vitest-environment jsdom
//
// Behavior tests for the SvelteKit *client* error hook in `hooks.client.ts`.
// This is the seam that captures errors thrown during navigation / load / render
// that don't surface as a window "error" event. We mock @cyborg7/observability/web
// so we assert what the hook *routes* (source + shape), not the delivery transport
// (the beacon/IPC transport is covered in observability's own client-error.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the observability web entry the hook imports. Both the SvelteKit hook
// (reportClientError) and the module-load side effect (installGlobalErrorHandlers)
// come from here.
const reportClientError = vi.fn();
const installGlobalErrorHandlers = vi.fn();
vi.mock("@cyborg7/observability/web", () => ({
  reportClientError,
  installGlobalErrorHandlers,
}));

// Minimal stand-in for SvelteKit's NavigationEvent — the hook only reads `error`
// and `message`, the rest is structurally irrelevant to its behavior. `message` is
// passed through verbatim (including undefined) so callers control the fallback path.
function makeHookArgs(error: unknown, message: string | undefined = "navigation failed") {
  return {
    error,
    message,
    event: {
      url: new URL("https://app.local/client/ws_42/c/general"),
      params: {},
      route: { id: "/client/[workspaceId]" },
    },
    status: 500,
  } as unknown as Parameters<typeof handleError>[0];
}

let handleError: (typeof import("./hooks.client.js"))["handleError"];

beforeEach(async () => {
  reportClientError.mockClear();
  installGlobalErrorHandlers.mockClear();
  // Fresh module instance each test so the module-load side effect re-runs.
  vi.resetModules();
  ({ handleError } = await import("./hooks.client.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hooks.client — module load", () => {
  it("installs the global error handlers for the web platform at import time", () => {
    // Importing the module (done in beforeEach) wires window.onerror /
    // unhandledrejection via the shared installer, tagged platform "web".
    expect(installGlobalErrorHandlers).toHaveBeenCalledTimes(1);
    expect(installGlobalErrorHandlers).toHaveBeenCalledWith({ platform: "web" });
  });
});

describe("hooks.client — handleError (SvelteKit client hook)", () => {
  it("reports the error through reportClientError tagged source 'sveltekit-client'", () => {
    const err = new Error("render blew up");
    handleError(makeHookArgs(err));

    expect(reportClientError).toHaveBeenCalledTimes(1);
    const arg = reportClientError.mock.calls[0][0];
    expect(arg.source).toBe("sveltekit-client");
    expect(arg.platform).toBe("web");
    expect(arg.message).toBe("render blew up");
    expect(arg.stack).toBe(err.stack);
  });

  it("returns a safe, user-facing message object that never leaks internals", () => {
    const err = new Error("secret stack with internal/path/leak.ts:42");
    // The hook is synchronous; narrow the MaybePromise<void | App.Error> return.
    const result = handleError(makeHookArgs(err)) as { message: string };

    expect(result).toEqual({ message: "Something went wrong. Please try again." });
    // The user-facing message must not echo the raw error text.
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("leak.ts");
  });

  it("falls back to the SvelteKit message when the thrown value is not an Error", () => {
    handleError(makeHookArgs("a bare string", "kit-level message"));

    const arg = reportClientError.mock.calls[0][0];
    expect(arg.source).toBe("sveltekit-client");
    // Non-Error throw → no Error.message, so the kit-provided message is used.
    expect(arg.message).toBe("kit-level message");
    expect(arg.stack).toBeNull();
  });

  it("uses a last-resort message when neither an Error nor a kit message is present", () => {
    // Build args directly so `message` stays undefined (a default param would
    // otherwise replace an explicit undefined).
    const args = { ...makeHookArgs(undefined), message: undefined } as unknown as Parameters<
      typeof handleError
    >[0];
    handleError(args);

    const arg = reportClientError.mock.calls[0][0];
    expect(arg.message).toBe("Unknown client error");
    expect(arg.stack).toBeNull();
  });

  it("still returns the safe user-facing object even for a non-Error throw", () => {
    const result = handleError(makeHookArgs({ weird: true }));
    expect(result).toEqual({ message: "Something went wrong. Please try again." });
  });
});
