// Global client-side error capture for the SPA. This is an adapter-static,
// ssr=false app, so the SvelteKit *client* hook is the right seam — there is no
// server runtime and no hooks.server.ts need.
//
// Two layers, both routing through @cyborg7/observability/web (NO token, NO
// OTel — a pure sendBeacon to the relay's /api/cyborg/client-log):
//   1. installGlobalErrorHandlers() — window.onerror + unhandledrejection.
//   2. handleError — SvelteKit's hook for errors thrown during navigation /
//      load / render that don't surface as a window error.
import type { HandleClientError } from "@sveltejs/kit";
import { installGlobalErrorHandlers, reportClientError } from "@cyborg7/observability/web";

// Wire window.onerror + unhandledrejection at module load (idempotent; no-op on
// non-browser hosts). +layout.svelte's onMount calls this again as a
// belt-and-suspenders safety net.
installGlobalErrorHandlers({ platform: "web" });

export const handleError: HandleClientError = ({ error, message }) => {
  const err = error instanceof Error ? error : undefined;
  reportClientError({
    source: "sveltekit-client",
    message: err?.message ?? message ?? "Unknown client error",
    stack: err?.stack ?? null,
    platform: "web",
  });

  // Safe, user-facing message — never leak internals.
  return { message: "Something went wrong. Please try again." };
};
