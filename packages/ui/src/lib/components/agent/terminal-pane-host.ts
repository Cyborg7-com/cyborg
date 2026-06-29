// Mount/visibility policy for TerminalPaneHost (internal docs Layer 1 +
// internal docs §#10 RAM bound). Extracted as pure functions so the logic is
// unit-testable without the SvelteKit runtime ($app/state). The component feeds
// them the current route + an LRU recency list; the {#each} renders only the
// MOUNTED subset (everything else unmounts), and within it exactly one pane is
// visible.
//
// Why this changed (the "kills the Mac" fix): PR #818 kept EVERY tracked
// terminal MOUNTED forever (display:none, never unmount). Each kept pane is a
// live xterm.js (scrollback 2000) holding a daemon subscription, so with an
// uncapped + persisted session list the renderer's RAM grows without bound as
// sessions accumulate + re-hydrate from localStorage every launch (internal docs
// §#10 pre-flagged exactly this). The daemon pty SURVIVES regardless (PtyHost),
// so a pane OUTSIDE the cap can be unmounted and re-attach instantly from the
// daemon snapshot/ring on return.
//
// The policy: keep a small LRU cache of MOUNTED panes (the active one + the few
// most-recently-viewed) and unmount the rest. Every MOUNTED pane stays FULLY LIVE
// (xterm + subscription intact) even while hidden, so switching between the ≤cap
// kept panes is instant and stays `live` (the #818 keep-alive win, preserved).
// Only panes beyond the cap pay a re-attach (snapshot replay) on return. Renderer
// RAM is bounded by the cap, not the (unbounded, persisted) session list.

// Max number of terminal panes kept MOUNTED + live at once. Beyond this the
// least-recently-viewed pane fully unmounts (its Svelte instance is destroyed);
// returning to it remounts from scratch (connecting → snapshot → live). The
// active pane is always included. Small by design — each mounted pane holds a
// live xterm + daemon subscription (even when hidden, for instant switch), so
// this cap is the ONLY bound on the number of live xterms.
export const MAX_MOUNTED_PANES = 4;

// The terminal whose route is active (visible), or null on every non-terminal
// route. `wsId` scopes the match to the current workspace so a stale path from a
// previous workspace never lights up a pane here.
export function activeTerminalId(
  pathname: string,
  params: { terminalId?: string },
  wsId: string | undefined,
): string | null {
  if (!wsId) return null;
  if (!pathname.startsWith(`/workspace/${wsId}/terminal/`)) return null;
  return params.terminalId ?? null;
}

// Update the LRU recency list (most-recent first) for a newly-active terminal.
// Pure: returns a new array, never mutates the input. A null active (we left the
// terminal area) leaves the order untouched so returning to the last terminal is
// still warm. An id already present is moved to the front.
export function bumpLru(lru: readonly string[], active: string | null): string[] {
  if (active === null) return [...lru];
  return [active, ...lru.filter((id) => id !== active)];
}

// Decide which tracked terminals stay MOUNTED, given the LRU recency order and
// the cap. The active terminal is ALWAYS mounted (it's visible). The remaining
// slots are filled by recency. Only sessions that actually exist are returned
// (a stale LRU id whose session was removed is dropped). Returns a Set for O(1)
// membership in the template's {#each} filter.
export function mountedTerminalIds(
  sessionIds: readonly string[],
  active: string | null,
  lru: readonly string[],
  cap: number = MAX_MOUNTED_PANES,
): Set<string> {
  const present = new Set(sessionIds);
  const mounted = new Set<string>();
  // The active terminal is always mounted first (it must be visible).
  if (active !== null && present.has(active)) mounted.add(active);
  // Then fill the rest of the budget by recency. Every id in `lru` was the ACTIVE
  // (visible) terminal at some point, so its pane was opened while visible — i.e.
  // xterm.open() ran against a real-size element. Keeping such a pane mounted while
  // hidden (keep-alive) is safe: its buffer + geometry are already correct.
  for (const id of lru) {
    if (mounted.size >= cap) break;
    if (present.has(id)) mounted.add(id);
  }
  // DO NOT backfill never-visited sessions here (the "reattached terminal is black"
  // bug, confirmed 2026-06-21 via CDP). The host overlay hides every non-active
  // pane (paneDisplay → display:none), so a pane mounted BEFORE it is ever the
  // active route opens its xterm against a 0×0 element: term.open() + the daemon's
  // one-shot ring replay (the bytes that paint the screen) land at zero geometry,
  // and flipping the pane visible later re-fits the viewport but never re-paints
  // that already-consumed replay → the user sees a black terminal. A full page
  // reload "fixed" it only because it mounts the pane VISIBLE (active route from
  // the start). So a pane must FIRST mount while active (visible); it may then be
  // kept alive hidden via the LRU above. A never-visited session simply mounts on
  // first navigation (active → visible → correct geometry), re-attaching instantly
  // from the daemon snapshot/ring. This keeps RAM bounded AND the screen correct.
  return mounted;
}

// On hydrate we must NOT eagerly mount every persisted session — N xterms at
// startup is the launch-time RAM spike (internal docs §#10). The host renders
// only the mounted subset, so this just bounds how many panes can be live
// before the user navigates. Identical to MAX_MOUNTED_PANES — kept as a named
// export so the hydrate-time intent reads clearly at the call site and a test
// can pin "startup never mounts more than the cap".
export const MAX_HYDRATED_PANES = MAX_MOUNTED_PANES;

// The CSS `display` for one keep-alive pane: the active terminal is shown, every
// other MOUNTED terminal is hidden (display:none) but stays fully live (its xterm
// + daemon subscription persist), so switching to it is instant + still `live`.
// NEVER returns a value that would remove the element from the tree.
export function paneDisplay(terminalId: string, active: string | null): "block" | "none" {
  return terminalId === active ? "block" : "none";
}

// The host overlay's own `display`: it covers the route content only while a
// terminal route is active; on every other route it hides (the mounted panes
// inside stay mounted + live, so returning to a tab is instant + still `live`).
export function hostDisplay(active: string | null): "flex" | "none" {
  return active !== null ? "flex" : "none";
}
