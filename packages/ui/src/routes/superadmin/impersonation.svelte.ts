// Impersonation session swap (contract §5). On Impersonate we stash the admin's
// own saved session (the {url, token} in localStorage), OVERWRITE the saved
// session with the minted short-lived target token, then HARD-RELOAD into
// /workspace. The app's normal boot path restores getSavedSession() →
// connectToServer, so the full reload re-establishes the WS client as the target
// cleanly — no in-page reconnect that would race the admin's live socket and
// throw "Not connected". Exiting restores the stashed admin session the same way
// and hard-reloads back to /superadmin.
//
// The stash is persisted to its own localStorage key so a reload mid-
// impersonation still surfaces the banner and can restore the admin.

import { getSavedSession } from "$lib/state/app.svelte.js";

const STASH_KEY = "cyborg7-superadmin-impersonation";

// The SAME localStorage key + shape that connectToServer persists (see
// core/state.svelte.ts → SESSION_KEY). Overwriting it and reloading is what lets
// the app boot AS the target. getSavedSession() only reads {url, token}, but we
// write the full { mode, url, token } object to stay byte-identical to login.
const SESSION_KEY = "cyborg7-session";

interface ImpersonationStash {
  // The admin's own session to restore on exit.
  adminUrl: string;
  adminToken: string;
  // Who we're impersonating (display only).
  targetEmail: string;
}

// Reactive marker the banner subscribes to. Mirrors localStorage so a reload
// rehydrates it.
export const impersonationState = $state<{ active: boolean; targetEmail: string | null }>({
  active: false,
  targetEmail: null,
});

function loadStash(): ImpersonationStash | null {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ImpersonationStash>;
    if (parsed.adminUrl && parsed.adminToken && parsed.targetEmail) {
      return parsed as ImpersonationStash;
    }
  } catch {
    // intentional: a corrupt stash is treated as "not impersonating".
  }
  return null;
}

// Persist a {url, token} pair into the canonical session key in the SAME shape
// connectToServer writes, so the next full-page boot restores it via
// getSavedSession() → connectToServer.
function writeSavedSession(url: string, token: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ mode: "direct", url, token }));
}

// Rehydrate the reactive marker from localStorage. Call once on app/banner mount
// so a reload mid-impersonation still shows the banner.
export function initImpersonation(): void {
  const stash = loadStash();
  impersonationState.active = stash !== null;
  impersonationState.targetEmail = stash?.targetEmail ?? null;
}

// Swap the active session to the impersonated user via a FULL-PAGE reload. The
// current saved session MUST be the admin's at call time (we're calling this
// from the admin UI), so we stash it, overwrite the saved session with the
// target token, and navigate hard to /workspace. We deliberately do NOT call
// connectToServer here — reconnecting the already-connected live client races
// the admin's socket and throws "Not connected"; the reload re-boots cleanly.
export function startImpersonation(targetToken: string, targetEmail: string): void {
  const admin = getSavedSession();
  if (!admin) throw new Error("No admin session to stash — cannot impersonate safely.");

  const stash: ImpersonationStash = {
    adminUrl: admin.url,
    adminToken: admin.token,
    targetEmail,
  };
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify(stash));
    // Overwrite the saved session with the target's so the reload boots AS them.
    writeSavedSession(admin.url, targetToken);
  } catch {
    throw new Error("Could not persist the impersonation session — aborted.");
  }

  // Mark active before navigating so the global banner shows immediately on the
  // first paint after the reload (initImpersonation also rehydrates it).
  impersonationState.active = true;
  impersonationState.targetEmail = targetEmail;

  // Hard navigate: re-runs the app's boot (getSavedSession → connectToServer) as
  // the target. No in-page reconnect.
  window.location.assign("/workspace");
}

// Restore the admin's own session and clear the stash, then HARD-RELOAD back to
// /superadmin so the app re-boots AS the admin. Used by the global banner's
// "Exit" action. We do NOT call connectToServer in-page.
export function exitImpersonation(): void {
  const stash = loadStash();
  if (!stash) {
    // Nothing to restore — just clear the marker (no navigation).
    impersonationState.active = false;
    impersonationState.targetEmail = null;
    return;
  }

  try {
    // Restore the admin session into the canonical key + drop the stash.
    writeSavedSession(stash.adminUrl, stash.adminToken);
    localStorage.removeItem(STASH_KEY);
  } catch {
    // intentional: best-effort; the reload below still attempts whatever stuck.
  }

  impersonationState.active = false;
  impersonationState.targetEmail = null;

  // Hard navigate back to the admin area: re-boots as the admin.
  window.location.assign("/superadmin");
}
