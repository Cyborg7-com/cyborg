/**
 * Viewport / responsive state. Drives the mobile layout (bottom nav + drawer)
 * vs the desktop layout (left rail + inline sidebar). Single source of truth so
 * the layout, the bottom nav, and the drawer all react to the same breakpoint.
 *
 * `isMobile` tracks the `sm` Tailwind breakpoint (640px) — below it we switch to
 * the phone shell. `drawerOpen` is the slide-in channel/daemon sidebar, only
 * meaningful on mobile (where the sidebar is otherwise off-screen).
 */
const SIDEBAR_COLLAPSED_KEY = "cyborg7-sidebar-collapsed";

class ViewportState {
  isMobile = $state(false);
  drawerOpen = $state(false);
  // Desktop-only preference: hide the inline channel/daemon sidebar for more
  // room (e.g. when working in a terminal). The left rail always stays visible.
  // Persisted across reloads. No effect on mobile (the sidebar is a drawer there).
  sidebarCollapsed = $state(false);
  #mql: MediaQueryList | null = null;

  init(): void {
    if (typeof window === "undefined" || this.#mql) return;
    this.#mql = window.matchMedia("(max-width: 639px)");
    this.isMobile = this.#mql.matches;
    this.#mql.addEventListener("change", (e) => {
      this.isMobile = e.matches;
      // Leaving mobile (rotate / resize) must not strand an open drawer.
      if (!e.matches) this.drawerOpen = false;
    });
    try {
      this.sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      // intentional: a blocked/unavailable localStorage just means the default
      // (sidebar shown) — not worth surfacing.
    }
  }

  openDrawer(): void {
    this.drawerOpen = true;
  }
  closeDrawer(): void {
    this.drawerOpen = false;
  }
  toggleDrawer(): void {
    this.drawerOpen = !this.drawerOpen;
  }

  setSidebarCollapsed(v: boolean): void {
    this.sidebarCollapsed = v;
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      // intentional: best-effort persistence of the sidebar preference.
    }
  }
  toggleSidebar(): void {
    this.setSidebarCollapsed(!this.sidebarCollapsed);
  }
}

export const viewportState = new ViewportState();
