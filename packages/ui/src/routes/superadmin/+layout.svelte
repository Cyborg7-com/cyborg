<script lang="ts">
  // Superadmin shell (contract §5). Separate from the workspace/Slack shell —
  // no rail, no sidebar. Guard flow:
  //   1. Not authenticated and no saved session → /login.
  //   2. Not authenticated but a saved session exists → restore it (cold start),
  //      same as the workspace route does under its splash.
  //   3. Authenticated → GET /api/superadmin/me. If !isSuperadmin show a clean
  //      403 with a link to /workspace; if superadmin render the admin chrome.
  //
  // The impersonation banner is now GLOBAL (rendered from the root +layout's
  // ImpersonationBanner), so it shows on /workspace too where impersonation
  // lands — it is intentionally NOT rendered here to avoid double-rendering.
  //
  // No <a>/<ul>/<li> anywhere: unlayered global `a`/`ul` rules in app.css beat
  // every Tailwind utility, so navigation goes through <button onclick={goto}>
  // and lists are rendered as <div> rows (mirrors the real workspace shell).
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getInitials } from "$lib/utils.js";
  import {
    authState,
    connectToServer,
    getSavedSession,
    clearSavedSession,
    AuthError,
  } from "$lib/state/app.svelte.js";
  import { getMe, SuperadminApiError } from "./api.js";

  let { children } = $props();

  type Phase = "checking" | "denied" | "ok" | "error";
  let phase = $state<Phase>("checking");
  let errorMsg = $state("");

  type NavIcon = "grid" | "building" | "people" | "shield" | "list";
  const nav: { label: string; href: string; icon: NavIcon }[] = [
    { label: "Overview", href: "/superadmin", icon: "grid" },
    { label: "Organizations", href: "/superadmin/orgs", icon: "building" },
    { label: "Users", href: "/superadmin/users", icon: "people" },
    { label: "Superadmins", href: "/superadmin/admins", icon: "shield" },
    { label: "Audit", href: "/superadmin/audit", icon: "list" },
  ];

  // Active-nav match: exact for Overview (its href is a prefix of every other),
  // longest-prefix for the rest.
  function isActive(href: string): boolean {
    const path = page.url.pathname;
    if (href === "/superadmin") return path === "/superadmin" || path === "/superadmin/";
    return path === href || path.startsWith(href + "/");
  }

  // Single-shot gate runner: restore the session if needed, then check /me.
  let ran = false;
  $effect(() => {
    if (ran) return;
    ran = true;
    void runGate();
  });

  async function runGate(): Promise<void> {
    if (!authState.authenticated) {
      const saved = getSavedSession();
      if (!saved) {
        goto("/login");
        return;
      }
      try {
        await connectToServer(saved.url, saved.token);
      } catch (e) {
        if (e instanceof AuthError) {
          clearSavedSession();
          goto("/login");
          return;
        }
        phase = "error";
        errorMsg = "Can't reach the server. It may be updating — try again in a moment.";
        return;
      }
    }

    try {
      const me = await getMe();
      phase = me.isSuperadmin ? "ok" : "denied";
    } catch (e) {
      if (e instanceof SuperadminApiError && (e.status === 401 || e.status === 403)) {
        // 401 → session no longer valid; 403 → authenticated but not superadmin.
        phase = "denied";
        return;
      }
      phase = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to verify access.";
    }
  }
</script>

<svelte:head>
  <title>Superadmin · Cyborg</title>
</svelte:head>

<!-- Inline nav icons (lucide-style line icons), keyed by name. -->
{#snippet navIcon(icon: NavIcon)}
  <svg
    class="h-[18px] w-[18px] shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if icon === "grid"}
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    {:else if icon === "building"}
      <path d="M3 21h18" />
      <path d="M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16" />
      <path d="M17 21V9h2a2 2 0 0 1 2 2v10" />
      <path d="M9 7h2M9 11h2M9 15h2" />
    {:else if icon === "people"}
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    {:else if icon === "shield"}
      <path d="M12 2l8 4v5c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V6l8-4z" />
    {:else if icon === "list"}
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    {/if}
  </svg>
{/snippet}

{#if phase === "checking"}
  <!-- Subtle centered loader instead of bare "Verifying…" text. -->
  <div class="flex h-full items-center justify-center bg-surface">
    <div class="flex flex-col items-center gap-3">
      <svg
        class="h-6 w-6 animate-spin text-content-muted"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle class="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" />
        <path
          class="opacity-90"
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        />
      </svg>
      <span class="text-[13px] text-content-muted">Verifying access</span>
    </div>
  </div>
{:else if phase === "error"}
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
    <p class="max-w-sm text-sm text-content-dim">{errorMsg}</p>
    <button
      type="button"
      onclick={() => goto("/workspace")}
      class="rounded-lg border border-edge px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-alt hover:text-content"
    >
      Back to workspace
    </button>
  </div>
{:else if phase === "denied"}
  <div class="flex h-full items-center justify-center bg-surface px-6">
    <div
      class="w-full max-w-sm rounded-[14px] px-6 py-7 text-center"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div
        class="mx-auto flex h-12 w-12 items-center justify-center rounded-[14px] bg-warning/15 text-warning"
      >
        <svg
          class="h-6 w-6"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2l8 4v5c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V6l8-4z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 class="mt-4 text-lg font-bold tracking-[-0.01em] text-content">Not authorized</h1>
      <p class="mt-1.5 text-sm text-content-muted">
        This area is restricted to platform superadmins. If you reached here by mistake, head back to
        your workspace.
      </p>
      <button
        type="button"
        onclick={() => goto("/workspace")}
        class="mt-5 w-full rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
      >
        Back to workspace
      </button>
    </div>
  </div>
{:else}
  <!-- Admin chrome: fixed left sidebar + scrollable content. No workspace rail. -->
  <div class="flex h-full overflow-hidden bg-surface">
    <nav
      class="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-edge"
      style="background: var(--bg-surface);"
    >
      <!-- Sidebar header: shield tile + wordmark. -->
      <div class="flex items-center gap-2.5 px-4 py-4">
        <span
          class="flex h-9 w-9 items-center justify-center rounded-[10px] bg-btn-primary-bg/15 text-btn-primary-bg"
        >
          <svg
            class="h-[18px] w-[18px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2l8 4v5c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V6l8-4z" />
          </svg>
        </span>
        <div class="min-w-0">
          <div class="text-[15px] font-bold leading-tight tracking-[-0.01em] text-content">
            Superadmin
          </div>
          <div class="text-[11px] leading-tight text-content-muted">Platform console</div>
        </div>
      </div>

      <div class="mx-3" style="height: 0.5px; background: var(--hairline);"></div>

      <!-- Nav items as buttons (NOT <a>/<ul>): avoids the cursed global link/list styles. -->
      <div class="flex flex-col gap-0.5 px-3 py-3">
        {#each nav as item (item.href)}
          {@const active = isActive(item.href)}
          <button
            type="button"
            onclick={() => goto(item.href)}
            aria-current={active ? "page" : undefined}
            class={[
              "pressable-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-surface-alt text-content"
                : "text-content-muted hover:bg-surface-alt/60 hover:text-content",
            ].join(" ")}
          >
            {@render navIcon(item.icon)}
            <span class="truncate">{item.label}</span>
          </button>
        {/each}
      </div>

      <!-- Footer: signed-in admin identity. -->
      {#if authState.user}
        <div class="mt-auto px-3 pb-3">
          <div class="mx-0" style="height: 0.5px; background: var(--hairline);"></div>
          <div class="flex items-center gap-2.5 px-2 pt-3">
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal text-[12px] font-bold text-teal-contrast"
            >
              {getInitials(authState.user.name ?? authState.user.email)}
            </div>
            <div class="min-w-0">
              {#if authState.user.name}
                <div class="truncate text-[13px] font-medium text-content">{authState.user.name}</div>
              {/if}
              <div class="truncate text-[12px] text-content-muted">{authState.user.email}</div>
            </div>
          </div>
        </div>
      {/if}
    </nav>

    <main class="min-w-0 flex-1 overflow-y-auto bg-surface">
      {@render children()}
    </main>
  </div>
{/if}
