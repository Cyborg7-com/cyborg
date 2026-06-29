import { reportClientError } from "./client-error.js";

let installed = false;

interface GlobalHandlerOptions {
  platform?: string;
  version?: string;
}

function currentContext(): { pathname?: string; href?: string; workspaceId?: string | null } {
  if (typeof window === "undefined") return {};
  const pathname = window.location?.pathname;
  const href = window.location?.href;
  // Match v1's workspace extraction from /client/:workspaceId.
  const workspaceId = pathname?.match(/\/client\/([^/]+)/)?.[1] ?? null;
  return { pathname, href, workspaceId };
}

/**
 * Idempotent: wires window.onerror + unhandledrejection to reportClientError.
 * Safe to call multiple times (only the first install takes effect). No-op when
 * there's no window (SSR / non-browser).
 */
export function installGlobalErrorHandlers(options: GlobalHandlerOptions = {}): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error as Error | undefined;
    reportClientError({
      source: "window.onerror",
      message: err?.message ?? event.message ?? "Uncaught error",
      stack: err?.stack ?? null,
      platform: options.platform,
      version: options.version,
      ...currentContext(),
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason as unknown;
    const err = reason instanceof Error ? reason : undefined;
    reportClientError({
      source: "unhandledrejection",
      message: err?.message ?? String(reason),
      stack: err?.stack ?? null,
      platform: options.platform,
      version: options.version,
      ...currentContext(),
    });
  });
}

// Test-only: clear the install guard between tests.
export function __resetGlobalHandlersForTests(): void {
  installed = false;
}
