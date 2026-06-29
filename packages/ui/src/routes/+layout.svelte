<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import ConnectionStatus from "$lib/components/ConnectionStatus.svelte";
  import Sonner from "$lib/components/ui/sonner/sonner.svelte";
  import ImpersonationBanner from "./superadmin/ImpersonationBanner.svelte";
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { isTauri, isTauriIOS, isTauriAndroid } from "$lib/mobile/push";
  import { setOpen as setKeyboardOpen } from "$lib/mobile/keyboard-state";
  import { keyboardViewport, rebaselineHeight } from "$lib/mobile/keyboard-viewport";
  import { installSwipeBack } from "$lib/mobile/swipeBack";
  import { installGlobalErrorHandlers, reportClientError } from "@cyborg7/observability/web";

  // Start tracking the mobile breakpoint (no-op on SSR / desktop).
  viewportState.init();

  // Global error capture (window.onerror + unhandledrejection). Idempotent —
  // hooks.client.ts already installs these at module load; this is a
  // belt-and-suspenders re-arm on the first client mount.
  onMount(() => {
    installGlobalErrorHandlers({ platform: "web" });
  });

  // Surface native Rust panics from the Tauri shell to the same observability
  // beacon JS errors use. The Rust panic hook (src-tauri/src/lib.rs) emits
  // `cyborg7://rust-panic` with { message, location }; forward it to
  // reportClientError → relay /api/cyborg/client-log. No-op off the Tauri shell.
  onMount(() => {
    if (!isTauri()) return;
    const platform = isTauriIOS() ? "tauri-ios" : isTauriAndroid() ? "tauri-android" : "tauri";
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<{ message?: string; location?: string }>(
          "cyborg7://rust-panic",
          (e) => {
            reportClientError({
              source: "tauri-rust",
              message: e.payload?.message ?? "Rust panic",
              stack: e.payload?.location ?? null,
              platform,
            });
          },
        );
        if (cancelled) stop();
        else unlisten = stop;
      } catch (err) {
        console.warn("[panic] rust-panic listener failed", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  // ── iOS keyboard / viewport foundation (Caveats #8, #14, #19, #20) ────────
  // Everything below is gated on `isTauriIOS()` so web / desktop / Android are
  // entirely unaffected — the listeners, CSS vars, and the `tauri-ios` class
  // only ever attach inside the Tauri iOS WKWebView shell.
  onMount(() => {
    if (!isTauriIOS()) return;

    const html = document.documentElement;
    // Scope hook for the iOS-only CSS in app.css (`html.tauri-ios …`).
    html.classList.add("tauri-ios");

    const cleanups: Array<() => void> = [];

    // ── visualViewport keyboard handling (Caveat #20) ──────────────────────
    const vv = window.visualViewport;
    if (vv) {
      const threshold = 150;
      let initialHeight = vv.height;
      let lastWidth = vv.width;

      // Pin --app-top at 0 unconditionally. With html + body both
      // `position: fixed; inset: 0` the layout viewport can't scroll, so
      // visualViewport.offsetTop SHOULD always be 0 — any non-zero value is a
      // transient WKWebView animation state. v1 learned that *following*
      // offsetTop caused the "top of app disappears for ~200ms" glitch, so we
      // never write --app-top from JS; the CSS default (0px) holds throughout.
      html.style.setProperty("--app-top", "0px");

      // Debounce the keyboard-OPEN→CLOSE transition. A mid-animation height
      // flick must not re-show the nav, so flip closed only once vv.height has
      // been stable for 200ms (past iOS's keyboard animation). No debounce on
      // SHOW so the nav can hide synchronously with the rising keyboard.
      let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleKeyboardState = (nextOpen: boolean) => {
        if (stabilizeTimer) {
          clearTimeout(stabilizeTimer);
          stabilizeTimer = null;
        }
        if (nextOpen) {
          setKeyboardOpen(true);
          return;
        }
        stabilizeTimer = setTimeout(() => {
          stabilizeTimer = null;
          setKeyboardOpen(false);
        }, 200);
      };

      const updateViewportVars = () => {
        html.style.setProperty("--app-vh", `${vv.height}px`);
      };

      const onResize = () => {
        // Rotation / new max height re-baselines the "no keyboard" height.
        if (vv.width !== lastWidth || vv.height > initialHeight) {
          initialHeight = vv.height;
          lastWidth = vv.width;
        }
        updateViewportVars();
        scheduleKeyboardState(initialHeight - vv.height > threshold);
        window.scrollTo(0, 0);
      };
      const onScroll = () => {
        updateViewportVars();
        window.scrollTo(0, 0);
      };

      onResize();
      vv.addEventListener("resize", onResize);
      vv.addEventListener("scroll", onScroll);
      cleanups.push(() => {
        vv.removeEventListener("resize", onResize);
        vv.removeEventListener("scroll", onScroll);
        if (stabilizeTimer) clearTimeout(stabilizeTimer);
      });

      // Native Swift `keyboardWillShow/Hide` call these BEFORE
      // visualViewport.resize fires, letting the nav hide synchronously with
      // the native composer's rise. They write through the same HMR-safe
      // keyboard-state module (Caveat #8) so a hot-reload can't orphan them.
      const win = window as unknown as {
        __cgKeyboardWillShow?: () => void;
        __cgKeyboardWillHide?: () => void;
      };
      win.__cgKeyboardWillShow = () => {
        if (stabilizeTimer) {
          clearTimeout(stabilizeTimer);
          stabilizeTimer = null;
        }
        setKeyboardOpen(true);
      };
      win.__cgKeyboardWillHide = () => {
        if (stabilizeTimer) {
          clearTimeout(stabilizeTimer);
          stabilizeTimer = null;
        }
        setKeyboardOpen(false);
      };
      cleanups.push(() => {
        delete win.__cgKeyboardWillShow;
        delete win.__cgKeyboardWillHide;
      });

      // Pre-empt iOS's focus-induced scroll. WKWebView's native "scroll
      // focused input into view" can fire before our visualViewport handler;
      // snap the document back to 0 synchronously + on the next frame.
      const onFocusIn = () => {
        window.scrollTo(0, 0);
        requestAnimationFrame(() => window.scrollTo(0, 0));
      };
      document.addEventListener("focusin", onFocusIn, true);
      cleanups.push(() =>
        document.removeEventListener("focusin", onFocusIn, true),
      );
    }

    // ── Belt-and-suspenders window scroll snap-back (Caveat #20, v1 parity) ──
    // WKWebView's inner UIScrollView can fire a `scroll` on window/document
    // AHEAD of visualViewport.scroll during the keyboard-show transition — the
    // brief "top of app disappears for ~200ms" glitch. The visualViewport
    // onScroll handler above only catches vv-level scrolls; this capture-phase
    // window listener catches window- AND document-level scrolls before any
    // other listener sees them, snapping both back to 0.
    const onWinScroll = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      const se = document.scrollingElement as HTMLElement | null;
      if (se && se.scrollTop !== 0) se.scrollTop = 0;
    };
    window.addEventListener("scroll", onWinScroll, { passive: true, capture: true });
    cleanups.push(() =>
      window.removeEventListener("scroll", onWinScroll, { capture: true }),
    );

    // ── External-link interception (Caveat #19) ────────────────────────────
    // A plain <a href="https://…"> inside the WKWebView would navigate the
    // WebView itself — destroying the app shell (no back button) and getting
    // the app rejected by App Review. Route http(s)/mailto/tel anchors through
    // the OS browser via Tauri's opener plugin instead. Capture phase so we
    // win before SvelteKit's link interceptor.
    const onLinkClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(href);
        } catch (err) {
          console.warn("[opener] fallback", err);
          window.open(href, "_blank", "noopener,noreferrer");
        }
      })();
    };
    document.addEventListener("click", onLinkClick, { capture: true });
    cleanups.push(() =>
      document.removeEventListener("click", onLinkClick, { capture: true }),
    );

    // ── Swipe-back peek gesture (Caveats #21, #22, #23) ────────────────────
    // Edge-swipe from the left (25px band) translates the live <main> over a
    // dimmed clone of the previous page, committing past 80px / midpoint to the
    // explicitly-computed parent route (history.back() is unreliable). Installs
    // the history.pushState/replaceState capture wrap + the touch listeners +
    // renders the absolute peek layer imperatively; cleanup restores history
    // and removes the layer + listeners.
    cleanups.push(installSwipeBack());

    return () => {
      html.classList.remove("tauri-ios");
      for (const fn of cleanups) fn();
    };
  });

  shellConfig.configure({
    appName: "Cyborg",
    rail: { showLabels: true },
    features: { agents: true, tasks: true },
    // Grouped by concern: you (General, Notifications) → workspace admin
    // (Workspace, Members, Billing) → infra/agents (Backend, Daemon, AI, MCP) →
    // About last. The `group` labels drive the desktop dual-pane category
    // headers (SettingsNav); mobile still renders one flat scrollable tab row.
    settingsTabs: [
      { id: "general", label: "General", href: "", group: "Account" },
      { id: "notifications", label: "Notifications", href: "/notifications", group: "Account" },
      { id: "workspace", label: "Workspace", href: "/workspace", group: "Workspace" },
      { id: "members", label: "Members", href: "/members", group: "Workspace" },
      { id: "billing", label: "Billing", href: "/billing", group: "Workspace" },
      { id: "integrations", label: "Integrations", href: "/integrations", group: "Workspace" },
      { id: "backend", label: "Backend", href: "/backend", group: "Infrastructure" },
      { id: "daemon", label: "Daemon", href: "/daemon", group: "Infrastructure" },
      { id: "ai", label: "AI", href: "/ai", group: "Infrastructure" },
      { id: "autonomy", label: "Autonomy", href: "/autonomy", group: "Infrastructure" },
      { id: "mcp", label: "MCP", href: "/mcp", group: "Infrastructure" },
      { id: "logs", label: "Logs", href: "/logs", group: "Infrastructure" },
      { id: "about", label: "About", href: "/about", group: "Infrastructure" },
    ],
  });

  // #619: gate the Tasks rail item on the `showTasksTab` preference (default OFF).
  // The recurring-schedule engine + RPCs stay intact regardless; this only adds /
  // removes the rail item + makes the /tasks route reachable from the rail.
  $effect(() => {
    shellConfig.setTasksTabVisible(preferencesState.showTasksTab);
  });

  // Restore persisted preferences on the CLIENT after hydration. In dev (Vite
  // SSR) the preferencesState singleton is first built server-side, where its
  // constructor bails before reading localStorage, then reused on the client —
  // so without this re-read showTasksTab would stay at its default `false` and
  // the toggle would not survive a refresh. The theme dodges this via the inline
  // boot script in app.html; the Tasks tab needs this explicit client re-read.
  // The $effect above reactively re-applies the restored value to the rail.
  onMount(() => {
    preferencesState.hydrateFromStorage();
  });

  // ── Android keyboard-follow (issue #460) ──────────────────────────────────
  // Parity with iOS WITHOUT a native composer: the soft keyboard shrinks the
  // VISUAL viewport (Chromium WebView default), so size the shell to
  // visualViewport.height (`--app-vh`) — the composer rides the keyboard
  // instead of being covered. Gated on isTauriAndroid() so web / desktop / iOS
  // are untouched; iOS keeps its own tuned block above.
  onMount(() => {
    if (!isTauriAndroid()) return;
    const html = document.documentElement;
    html.classList.add("tauri-android");
    const vv = window.visualViewport;
    if (!vv) return;

    let baseline = vv.height;
    let lastWidth = vv.width;

    const apply = () => {
      baseline = rebaselineHeight(
        { width: vv.width, height: vv.height },
        { width: lastWidth, baseline },
      );
      lastWidth = vv.width;
      const { appVh, keyboardInset, keyboardOpen } = keyboardViewport(vv.height, baseline);
      html.style.setProperty("--app-vh", `${appVh}px`);
      html.style.setProperty("--cg-keyboard-inset", `${keyboardInset}px`);
      setKeyboardOpen(keyboardOpen);
      // adjustPan WebViews can scroll the layout viewport up under the keyboard;
      // the shell is position:fixed, so snap the document back to 0 (parity with
      // the iOS scroll-snap) to keep the top bar pinned.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      html.classList.remove("tauri-android");
    };
  });

  let { children } = $props();
</script>

<svelte:head>
  <title>Cyborg</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  <div class="drag-region"><ConnectionStatus /></div>
  <!-- Global impersonation banner: shows on every page (incl. /workspace) while a
       superadmin is impersonating, so there's always a way to exit. -->
  <ImpersonationBanner />
  <div class="flex-1 overflow-hidden">
    {@render children()}
  </div>
</div>
<Sonner />
