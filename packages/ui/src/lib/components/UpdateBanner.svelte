<script lang="ts">
  // Global "a new version is available" banner for the desktop app. The Electron
  // auto-updater already checks on launch + every 6h, auto-DOWNLOADS new builds,
  // and broadcasts its status to the renderer (cyborg7Desktop.update.onStatus).
  // This surfaces that status app-wide so the user never has to open Settings ▸
  // About to find out — it shows wherever they are (Home / Chat / Agents / …).
  //
  // - "downloading" → a subtle, non-dismissible progress line.
  // - "ready"       → a prominent banner with an Install & Restart button.
  // Dismiss is PER-VERSION (localStorage), so hiding it never suppresses the
  // NEXT release. No-ops in a plain browser (no updater bridge there).
  import { onMount } from "svelte";

  interface UpdateStatus {
    state: "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
    version: string | null;
    progress: number;
    error: string | null;
    lastCheckedAt: number | null;
  }
  interface DesktopBridge {
    update: {
      getStatus: () => Promise<UpdateStatus>;
      install: () => Promise<{ ok: boolean; error?: string }>;
      onStatus: (handler: (s: UpdateStatus) => void) => () => void;
    };
  }

  const desktop = (window as unknown as { cyborg7Desktop?: DesktopBridge }).cyborg7Desktop;

  const DISMISS_KEY = "cyborg7_update_dismissed";

  let status = $state<UpdateStatus | null>(null);
  let dismissedVersion = $state<string | null>(null);
  let installing = $state(false);

  onMount(() => {
    if (!desktop) return;
    try {
      dismissedVersion = localStorage.getItem(DISMISS_KEY);
    } catch {
      dismissedVersion = null;
    }
    void desktop.update
      .getStatus()
      .then((s) => {
        status = s;
        return s;
      })
      // intentional: best-effort initial desktop update-status probe; onStatus below is the live source + carries errors.
      .catch(() => {});
    return desktop.update.onStatus((s) => {
      status = s;
    });
  });

  // The actionable banner: a build is downloaded and ready to install, and the
  // user hasn't dismissed THIS version.
  const showReady = $derived(
    !!status && status.state === "ready" && status.version !== dismissedVersion,
  );
  // Subtle heads-up while the new build downloads in the background.
  const showDownloading = $derived(!!status && status.state === "downloading");

  // Click feedback for Install & Restart: install() quits the app mid-flight, so
  // this state never resolves on success — the spinner IS the goodbye. Only a
  // rejection re-enables the button.
  async function install(): Promise<void> {
    if (!desktop || installing) return;
    installing = true;
    try {
      const result = await desktop.update.install();
      if (!result.ok) installing = false;
    } catch {
      installing = false;
    }
  }

  function dismiss(): void {
    const v = status?.version ?? null;
    dismissedVersion = v;
    try {
      if (v) localStorage.setItem(DISMISS_KEY, v);
    } catch {
      /* private mode / quota — the in-memory dismiss still hides it this session */
    }
  }
</script>

{#if showReady}
  <div
    class="flex h-7 shrink-0 items-center gap-2 px-3 text-[12px] border-b border-edge-dim"
    style="background: color-mix(in srgb, var(--c7-accent) 12%, transparent); color: var(--text-primary);"
  >
    <span class="text-[13px] leading-none">{"\u{1F389}"}</span>
    <span class="truncate">
      Cyborg {status?.version ?? ""} is ready.
    </span>
    <button
      type="button"
      onclick={install}
      disabled={installing}
      class="ml-auto cursor-pointer rounded px-2 py-0.5 text-[11.5px] font-semibold transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
      style="background-color: var(--btn-primary-bg); color: var(--btn-primary-text);"
    >
      {installing ? "Restarting…" : "Install & Restart"}
    </button>
    <button
      type="button"
      onclick={dismiss}
      class="shrink-0 rounded p-0.5 text-content-muted hover:bg-edge hover:text-content"
      title="Dismiss until the next version"
      aria-label="Dismiss update banner"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </div>
{:else if showDownloading}
  <div
    class="flex h-7 shrink-0 items-center gap-2 px-3 text-[12px] border-b border-edge-dim text-content-muted"
  >
    <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style="background: var(--c7-accent);"></span>
    <span class="truncate">
      Downloading update{status?.version ? ` ${status.version}` : ""}…
      {#if status && status.progress > 0}{status.progress}%{/if}
    </span>
  </div>
{/if}
