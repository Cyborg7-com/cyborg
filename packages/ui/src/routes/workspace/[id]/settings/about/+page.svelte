<script lang="ts">
  import { onMount } from "svelte";
  import { authState, connectionState, workspaceState } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import Loader2 from "@lucide/svelte/icons/loader-2";

  const user = $derived(authState.user);
  const connection = $derived(connectionState.status);
  const workspace = $derived(workspaceState.current);

  interface UpdateStatus {
    state: "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
    version: string | null;
    progress: number;
    error: string | null;
    lastCheckedAt: number | null;
  }
  interface DesktopBridge {
    getVersion: () => Promise<string>;
    update: {
      getStatus: () => Promise<UpdateStatus>;
      check: () => Promise<{ ok: boolean; version?: string | null; error?: string }>;
      install: () => Promise<{ ok: boolean; error?: string }>;
      onStatus: (handler: (s: UpdateStatus) => void) => () => void;
    };
  }

  // Auto-update IPC is exposed by the Electron preload; absent in the browser.
  const desktop = (window as unknown as { cyborg7Desktop?: DesktopBridge }).cyborg7Desktop;

  let appVersion = $state<string | null>(null);
  let status = $state<UpdateStatus | null>(null);

  const checking = $derived(status?.state === "checking");
  const ready = $derived(status?.state === "ready");

  onMount(() => {
    if (!desktop) return;
    void desktop
      .getVersion()
      .then((v) => {
        appVersion = v;
        return v;
      })
      // intentional: optional desktop version probe; on failure the version row stays blank. Not user-facing.
      .catch(() => {});
    void desktop.update
      .getStatus()
      .then((s) => {
        status = s;
        return s;
      })
      // intentional: best-effort initial update-status probe; the onStatus subscription below is the live source + surfaces errors.
      .catch(() => {});
    return desktop.update.onStatus((s) => {
      status = s;
    });
  });

  async function checkForUpdates(): Promise<void> {
    // intentional: the check's outcome (incl. failures) flows through onStatus as status.state === "error" (rendered "Update check failed").
    await desktop?.update.check().catch(() => {});
  }

  // Click feedback for "Restart & install": the app quits mid-flight, so this
  // state never resolves on success — the spinner IS the goodbye. Only an
  // install() rejection re-enables the button.
  let installing = $state(false);

  async function installUpdate(): Promise<void> {
    if (!desktop || installing) return;
    installing = true;
    try {
      const result = await desktop.update.install();
      if (!result.ok) installing = false;
    } catch {
      installing = false;
    }
  }

  function statusLabel(s: UpdateStatus | null): string {
    switch (s?.state) {
      case "checking":
        return "Checking for updates…";
      case "up-to-date":
        return "You're on the latest version.";
      case "downloading":
        return `Downloading update… ${s.progress}%`;
      case "ready":
        return `Update ${s.version ?? ""} ready — restart to install.`;
      case "error":
        return `Update check failed: ${s.error ?? "unknown error"}`;
      default:
        return "";
    }
  }
</script>

{#if viewportState.isMobile}
  <!-- ── Mobile: iOS grouped inset cards ── -->
  <div class="px-4 pb-8 pt-3 space-y-6">

    <!-- Application -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Application</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Name</span>
          <span class="text-[16px] font-semibold text-content">Cyborg7</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Version</span>
          <span class="font-mono text-[15px] text-content-muted">{appVersion ?? (desktop ? "…" : "Web")}</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between gap-3 px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Architecture</span>
          <span class="text-right text-[13px] text-content-muted">Distributed daemon</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between gap-3 px-[16px] py-[10px]">
          <span class="text-[16px] text-content">UI Framework</span>
          <span class="text-right text-[13px] text-content-muted">SvelteKit + Tailwind</span>
        </div>
      </div>
    </div>

    <!-- Updates (desktop bridge only) -->
    {#if desktop}
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Updates</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px] space-y-3">
          <div>
            <p class="text-[16px] text-content">Software updates</p>
            <p class="mt-0.5 text-[13px] text-content-muted">
              {statusLabel(status) || "Check whether a newer version is available."}
            </p>
          </div>
          {#if ready}
            <button
              type="button"
              onclick={installUpdate}
              disabled={installing}
              class="pressable h-[44px] w-full rounded-[10px] bg-btn-primary-bg text-[16px] font-medium text-btn-primary-text disabled:opacity-50 focus-ring"
              aria-busy={installing}
            >
              {#if installing}
                Restarting…
              {:else}
                Restart &amp; install
              {/if}
            </button>
          {:else}
            <button
              type="button"
              onclick={checkForUpdates}
              disabled={checking}
              class="pressable h-[44px] w-full rounded-[10px] border border-edge text-[16px] text-content disabled:opacity-50 focus-ring"
              aria-busy={checking}
            >
              {#if checking}
                Checking…
              {:else}
                Check for updates
              {/if}
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Connection -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Connection</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Status</span>
          <div class="flex items-center gap-2">
            <span class={[
              "h-2 w-2 rounded-full",
              connection === "connected" ? "bg-online" : connection === "reconnecting" ? "bg-warning animate-pulse" : "bg-error",
            ].join(" ")}></span>
            <span class="text-[16px] font-medium capitalize text-content">{connection}</span>
          </div>
        </div>
        {#if workspace}
          <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
          <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
            <span class="text-[16px] text-content">Workspace</span>
            <span class="text-[15px] text-content-muted">{workspace.name}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- User -->
    {#if user}
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">User</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
            <span class="text-[16px] text-content">Name</span>
            <span class="text-[15px] text-content-muted">{user.name}</span>
          </div>
          <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
          <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
            <span class="text-[16px] text-content">Email</span>
            <span class="font-mono text-[13px] text-content-muted">{user.email}</span>
          </div>
        </div>
      </div>
    {/if}

  </div>
{:else}
  <!-- ── Desktop: original layout (byte-equal) ── -->
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
    <header>
      <h1 class="text-lg font-semibold text-content">About</h1>
      <p class="mt-1 text-xs text-content-muted">Application and connection info</p>
    </header>

    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Application
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Name</span>
          <span class="text-sm font-semibold text-content">Cyborg7</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Version</span>
          <span class="text-sm font-mono text-content-muted">{appVersion ?? (desktop ? "…" : "Web")}</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Architecture</span>
          <span class="text-sm text-content-muted">Distributed daemon (Paseo fork)</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">UI Framework</span>
          <span class="text-sm text-content-muted">SvelteKit + Tailwind CSS</span>
        </div>
      </div>
    </section>

    {#if desktop}
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Updates
        </span>
        <div class="rounded-lg border border-edge px-4 py-3 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm text-content">Software updates</p>
              <p class="text-xs text-content-muted">
                {statusLabel(status) || "Check whether a newer version is available."}
              </p>
            </div>
            {#if ready}
              <!-- Press feedback + a persistent "Restarting…" spinner: the app
                   quits under the user's feet, so the in-flight state is the only
                   signal anything happened. min-w keeps the swap from jumping. -->
              <Button
                size="sm"
                class="shrink-0 min-w-[8.5rem] transition-[background-color,transform] active:scale-[0.98]"
                onclick={installUpdate}
                disabled={installing}
                aria-busy={installing}
              >
                {#if installing}
                  <Loader2 class="size-4 animate-spin" />
                  Restarting…
                {:else}
                  Restart &amp; install
                {/if}
              </Button>
            {:else}
              <Button
                size="sm"
                variant="outline"
                class="shrink-0 min-w-[9.5rem] transition-[background-color,transform] active:scale-[0.98]"
                onclick={checkForUpdates}
                disabled={checking}
                aria-busy={checking}
              >
                {#if checking}
                  <Loader2 class="size-4 animate-spin" />
                  Checking…
                {:else}
                  Check for updates
                {/if}
              </Button>
            {/if}
          </div>
        </div>
      </section>
    {/if}

    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Connection
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Status</span>
          <div class="flex items-center gap-2">
            <span class={[
              "h-2 w-2 rounded-full",
              connection === "connected" ? "bg-online" : connection === "reconnecting" ? "bg-warning animate-pulse" : "bg-error",
            ].join(" ")}></span>
            <span class="text-sm font-medium text-content capitalize">{connection}</span>
          </div>
        </div>
        {#if workspace}
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Workspace</span>
            <span class="text-sm text-content">{workspace.name}</span>
          </div>
        {/if}
      </div>
    </section>

    {#if user}
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          User
        </span>
        <div class="rounded-lg border border-edge divide-y divide-edge">
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Name</span>
            <span class="text-sm text-content">{user.name}</span>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Email</span>
            <span class="text-sm font-mono text-content-muted">{user.email}</span>
          </div>
        </div>
      </section>
    {/if}
  </div>
{/if}
